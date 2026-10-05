import { createHash, randomUUID } from "node:crypto";
import { operationalLog } from "@pi-cloud/observability";
import { sql, type Kysely, type Transaction } from "kysely";
import { readInputQueue } from "./input-queue-snapshot.ts";
import { readReturnedInputs } from "./stopped-inputs.ts";
import type { Database } from "@pi-cloud/database";
import { advanceLaneReadiness } from "@pi-cloud/runtime-core/run-readiness";
import {
  type InputQueueResource,
  type QueuedInputAction,
  type QueuedInputActionResult,
  type AcknowledgeReturnedInputs,
} from "@pi-cloud/protocol";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";
import { parseUserUploads, reviewedModel, assertUserInputBudget } from "@pi-cloud/protocol";
import { bindInputUploads } from "./workspace-upload-service.ts";
import type { TurnSteeringService } from "./turn-steering-service.ts";
import { acceptsSteer, holdQueuedSteer, lockSteerTarget } from "./queued-steer.ts";

function conflict(): never {
  throw new ControlPlaneStoreError(
    "conflict",
    "The queue changed or the input is starting; refresh and try again",
  );
}
function busy(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "55P03";
}
function number(value: string | number | bigint): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error("Invalid queue position/version");
  return n;
}

// Both reconciliation reads use the same canonical input identity and scope.
const consumedInput = sql<boolean>`exists(select 1 from pi_session_log e
  where e.kind='entry' and e.tenant_id=c.tenant_id and e.session_id=c.payload->>'piSessionId'
    and e.turn_id=c.turn_id and e.id=('pc-agent-input-' || c.id::text))`;
const earlierDeliveryPending = sql<boolean>`exists(select 1 from turn_control_requests prior
  join runs held on held.queued_steer_id=prior.id and held.state='queued'
  where prior.tenant_id=c.tenant_id and prior.session_id=c.session_id
    and prior.target_run_id=c.target_run_id and prior.kind='queue'
    and prior.state in ('pending','dispatched')
    and (prior.payload->>'queueOrder')::bigint < (c.payload->>'queueOrder')::bigint)`;
export type QueuedInputOwnership = {
  partitions: readonly number[];
  partitionCount: number;
  current(): boolean;
};
type QueueScope = { tenantId: string; sessionId: string };

/** Mutable input intents in the existing Run queue, not another scheduler. */
export class QueuedInputService {
  readonly #database: Kysely<Database>;
  readonly #steering: Pick<TurnSteeringService, "deliverQueued">;
  readonly #autoStart: boolean;
  #timer: ReturnType<typeof setInterval> | undefined;
  #working: Promise<void> | undefined;
  #recovering: Promise<void> | undefined;
  #recoveryNeeded = false;
  readonly #pending = new Map<string, QueueScope & { due: number }>();
  readonly #held = new Map<string, number>();
  #heldOverflow = false;
  #generation = 0;
  #wakeVersion = 0;
  #owner: QueuedInputOwnership | undefined;
  #recoveryAfter: string | undefined;
  #closed = false;
  #lastFailureLog = 0;

  #recordFailure(): void {
    if (Date.now() - this.#lastFailureLog < 30_000) return;
    this.#lastFailureLog = Date.now();
    try {
      operationalLog({
        service: "pi-cloud-control-plane",
        level: "error",
        event: "queued_input.reconciliation.failed",
        attributes: { code: "queue_dependency_unavailable" },
      });
    } catch {
      /* Logging is not a delivery dependency. */
    }
  }

  constructor(options: {
    database: Kysely<Database>;
    steering: Pick<TurnSteeringService, "deliverQueued">;
    autoStart?: boolean;
  }) {
    this.#database = options.database;
    this.#steering = options.steering;
    this.#autoStart = options.autoStart ?? false;
  }

  onModuleInit(): void {
    if (!this.#autoStart) return;
    this.#timer = setInterval(() => {
      this.#pump();
      if (this.#recoveryNeeded && !this.#recovering && this.#pending.size < 2048)
        void this.recoverPending();
    }, 1000);
    this.#timer.unref();
  }
  async onApplicationShutdown(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    await this.#recovering;
    await this.#working;
    this.reset();
  }
  reset(): void {
    this.#generation++;
    this.#held.clear();
    this.#pending.clear();
    this.#heldOverflow = false;
    this.#owner = undefined;
    this.#recoveryAfter = undefined;
    this.#recoveryNeeded = false;
  }
  #rememberHeld(scope: QueueScope): void {
    const key = `${scope.tenantId}:${scope.sessionId}`;
    if (this.#held.size < 4096 || this.#held.has(key)) this.#held.set(key, ++this.#wakeVersion);
    else this.#heldOverflow = true;
  }
  notifySession(tenantId: string, sessionId: string, discoverHeld = false): void {
    if (this.#closed) return;
    const scope = { tenantId, sessionId },
      key = `${tenantId}:${sessionId}`;
    if (!discoverHeld && !this.#held.has(key) && !this.#heldOverflow) return;
    this.#rememberHeld(scope);
    this.#schedule(scope, 0);
    this.#pump();
  }
  #schedule(scope: QueueScope, delayMs: number): void {
    if (this.#closed || !this.#autoStart) return;
    const key = `${scope.tenantId}:${scope.sessionId}`;
    if (this.#pending.size >= 4096 && !this.#pending.has(key)) {
      this.#recoveryNeeded = true;
      return;
    }
    this.#pending.set(key, {
      ...scope,
      due: Math.min(this.#pending.get(key)?.due ?? Infinity, performance.now() + delayMs),
    });
  }
  async recoverPending(owner?: QueuedInputOwnership): Promise<void> {
    if (owner) {
      this.reset();
      this.#owner = owner;
    }
    if (this.#closed || !this.#autoStart || !this.#owner?.current()) return;
    this.#recoveryNeeded = true;
    if (this.#recovering) {
      await this.#recovering;
      if (this.#recoveryNeeded) return this.recoverPending();
      return;
    }
    const generation = this.#generation,
      assignment = this.#owner;
    const current = () => !this.#closed && generation === this.#generation && assignment.current();
    this.#recovering = (async () => {
      this.#recoveryNeeded = false;
      if (!assignment.partitions.length) return;
      while (current()) {
        let query = this.#database
          .selectFrom("runs as held")
          .innerJoin("sessions as hs", "hs.id", "held.session_id")
          .innerJoin("pi_sessions as physical", (join) =>
            join
              .onRef("physical.tenant_id", "=", "hs.tenant_id")
              .onRef("physical.id", "=", "hs.pi_session_id"),
          )
          .select(["held.tenant_id", "held.session_id"])
          .where("held.state", "=", sql.lit("queued"))
          .where("held.queued_steer_id", "is not", null)
          .where(
            sql<boolean>`physical.session_hash % ${assignment.partitionCount} = any(${[...assignment.partitions]}::int[])`,
          )
          .distinct()
          .orderBy("held.session_id")
          .limit(256);
        if (this.#recoveryAfter) query = query.where("held.session_id", ">", this.#recoveryAfter);
        const rows = await query.execute();
        if (!current()) return;
        let overflow = false;
        for (const row of rows) {
          if (
            this.#pending.size >= 4096 &&
            !this.#pending.has(`${row.tenant_id}:${row.session_id}`)
          )
            overflow = true;
          const scope = { tenantId: row.tenant_id, sessionId: row.session_id };
          this.#rememberHeld(scope);
          this.#schedule(scope, 0);
        }
        this.#pump();
        if (overflow) {
          this.#recoveryNeeded = true;
          break;
        }
        this.#recoveryAfter = rows.length === 256 ? rows.at(-1)!.session_id : undefined;
        if (rows.length < 256) break;
        if (this.#pending.size >= 3840) {
          this.#recoveryNeeded = true;
          break;
        }
      }
    })()
      .catch(() => {
        if (current()) {
          this.#recoveryNeeded = true;
          this.#recordFailure();
        }
      })
      .finally(() => {
        this.#recovering = undefined;
      });
    await this.#recovering;
  }
  #pump(): void {
    if (this.#closed || this.#working || !this.#autoStart) return;
    const generation = this.#generation;
    const current = () => generation === this.#generation;
    const ready = [...this.#pending.entries()]
      .filter(([, s]) => s.due <= performance.now())
      .slice(0, 32);
    if (!ready.length) return;
    for (const [id] of ready) this.#pending.delete(id);
    let next = 0;
    const work = async () => {
      while (!this.#closed && current() && next < ready.length) {
        const scope = ready[next++]![1];
        try {
          await this.reconcileOnce(scope, current);
        } catch {
          this.#recordFailure();
          if (current()) this.#schedule(scope, 1000);
        }
      }
    };
    this.#working = Promise.all([work(), work()])
      .then(() => {})
      .finally(() => {
        this.#working = undefined;
        this.#pump();
      });
  }

  async list(
    tenantId: string,
    sessionId: string,
    page: { afterPosition?: number; viewVersion?: string } = {},
  ): Promise<InputQueueResource> {
    return readInputQueue(this.#database, tenantId, sessionId, page);
  }

  async #lockSession(tx: Transaction<Database>, tenantId: string, sessionId: string) {
    const session = await tx
      .selectFrom("sessions")
      .select([
        "id",
        "row_version",
        "session_kind",
        "pruned_at",
        "state",
        "pi_session_id",
        "project_id",
        "workspace_id",
        "working_directory",
      ])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", sessionId)
      .forNoKeyUpdate()
      .executeTakeFirst();
    if (!session || session.pruned_at !== null)
      throw new ControlPlaneStoreError("not_found", "Session was not found");
    if (session.session_kind !== "conversation")
      throw new ControlPlaneStoreError("conflict", "Delegated Sessions are read-only");
    return session;
  }

  returned(
    tenantId: string,
    sessionId: string,
    page: { requestId?: string; afterPosition?: number } = {},
  ) {
    return readReturnedInputs(this.#database, tenantId, sessionId, page);
  }

  async acknowledgeReturned(
    tenantId: string,
    sessionId: string,
    request: AcknowledgeReturnedInputs,
  ): Promise<void> {
    await this.#database.transaction().execute(async (tx) => {
      await this.#lockSession(tx, tenantId, sessionId);
      const requestRow = await tx
        .selectFrom("turn_control_requests")
        .select([
          "id",
          sql<boolean>`exists(select 1 from runs pending
          where pending.tenant_id=turn_control_requests.tenant_id
            and pending.session_id=turn_control_requests.session_id
            and pending.input_return_request_id=turn_control_requests.id
            and pending.state='queued')`.as("pending"),
        ])
        .where("tenant_id", "=", tenantId)
        .where("session_id", "=", sessionId)
        .where("id", "=", request.requestId)
        .where("kind", "=", "cancel")
        .executeTakeFirst();
      if (!requestRow) throw new ControlPlaneStoreError("not_found", "Input return was not found");
      if (requestRow.pending)
        throw new ControlPlaneStoreError("conflict", "Steer consumption is not resolved");
      const changed = await tx
        .updateTable("turn_control_requests")
        .set({ payload: sql`payload || '{"inputReturnPending":false}'::jsonb` })
        .where("id", "=", request.requestId)
        .where(sql<boolean>`payload->>'inputReturnPending'='true'`)
        .returning("id")
        .executeTakeFirst();
      if (changed)
        await sql`select pi_cloud_input_queue_change(${tenantId}::uuid,${sessionId}::uuid)`.execute(
          tx,
        );
    });
  }

  async #lockInput(tx: Transaction<Database>, tenantId: string, sessionId: string, turnId: string) {
    const row = await tx
      .selectFrom("runs as r")
      .innerJoin("turns as t", "t.id", "r.turn_id")
      .select([
        "r.id",
        "r.turn_id",
        "r.mailbox_position",
        "r.queued_steer_id",
        "r.input_return_request_id",
        "r.state",
        "r.lease_id",
        "t.state as turnState",
        "t.input_uploads",
        "t.input_text",
        "t.provider",
        "t.model_id",
      ])
      .where("r.tenant_id", "=", tenantId)
      .where("r.session_id", "=", sessionId)
      .where("r.turn_id", "=", turnId)
      .forNoKeyUpdate(["r", "t"])
      .noWait()
      .executeTakeFirst();
    if (!row) throw new ControlPlaneStoreError("not_found", "Pending input was not found");
    if (
      row.state !== "queued" ||
      row.turnState !== "queued" ||
      row.lease_id !== null ||
      row.input_return_request_id !== null
    )
      conflict();
    return row;
  }

  async #changed(tx: Transaction<Database>, tenantId: string, sessionId: string): Promise<void> {
    await tx
      .updateTable("sessions")
      .set({ row_version: sql`row_version + 1`, updated_at: sql`clock_timestamp()` })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", sessionId)
      .execute();
    await advanceLaneReadiness(tx, tenantId, sessionId);
  }

  async #cancel(
    tx: Transaction<Database>,
    tenantId: string,
    runId: string,
    turnId: string,
    reason: string,
  ): Promise<void> {
    await tx
      .updateTable("runs")
      .set({
        state: "cancelled",
        ready_at: null,
        settled_at: sql`clock_timestamp()`,
        updated_at: sql`clock_timestamp()`,
        stop_reason: reason,
        row_version: sql`row_version + 1`,
      })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", runId)
      .where("state", "=", "queued")
      .executeTakeFirstOrThrow();
    await tx
      .updateTable("turns")
      .set({ state: "cancelled", stop_reason: reason, settled_at: sql`clock_timestamp()` })
      .where("tenant_id", "=", tenantId)
      .where("id", "=", turnId)
      .execute();
    await tx
      .insertInto("run_transitions")
      .values({
        id: randomUUID(),
        tenant_id: tenantId,
        run_id: runId,
        from_state: "queued",
        to_state: "cancelled",
        reason,
        occurred_at: sql`clock_timestamp()`,
      })
      .execute();
  }

  async mutate(
    tenantId: string,
    sessionId: string,
    turnId: string,
    idempotencyKey: string,
    request: QueuedInputAction,
  ): Promise<QueuedInputActionResult> {
    const action: QueuedInputAction =
      request.action === "edit"
        ? {
            action: "edit",
            revision: request.revision,
            text: request.text.trim(),
            ...(request.uploadIds !== undefined ? { uploadIds: request.uploadIds } : {}),
          }
        : request.action === "move"
          ? { action: "move", revision: request.revision, direction: request.direction }
          : request.action === "steer"
            ? { action: "steer", revision: request.revision, targetTurnId: request.targetTurnId }
            : { action: request.action, revision: request.revision };
    if (action.action === "steer" && request.action === "steer" && request.text !== undefined)
      action.text = request.text.trim();
    const hash = createHash("sha256")
      .update(JSON.stringify({ sessionId, turnId, action }))
      .digest("hex");
    let replayed: boolean;
    try {
      replayed = await this.#database.transaction().execute(async (tx) => {
        const session = await this.#lockSession(tx, tenantId, sessionId);
        const previous = await tx
          .selectFrom("turn_control_requests")
          .select(["kind", "request_sha256"])
          .where("tenant_id", "=", tenantId)
          .where("session_id", "=", sessionId)
          .where("idempotency_key", "=", idempotencyKey)
          .executeTakeFirst();
        if (previous) {
          if (previous.kind !== "queue" || previous.request_sha256 !== hash)
            throw new ControlPlaneStoreError(
              "idempotency_conflict",
              "Idempotency-Key was used for another queue operation",
            );
          return true;
        }
        if (number(session.row_version) !== action.revision) conflict();
        const source = await this.#lockInput(tx, tenantId, sessionId, turnId);
        if (source.queued_steer_id !== null) conflict();
        const uploads =
          action.action === "edit" && action.uploadIds !== undefined
            ? await bindInputUploads(tx, {
                tenantId,
                sessionId,
                workspaceId: session.workspace_id,
                workingDirectory: session.working_directory,
                ids: action.uploadIds,
              })
            : action.action === "edit" || action.action === "steer"
              ? parseUserUploads(source.input_uploads)
              : [];
        if (action.action === "edit" || action.action === "steer") {
          try {
            assertUserInputBudget(action.text ?? source.input_text ?? "", uploads);
          } catch (error) {
            throw new ControlPlaneStoreError("invalid_request", (error as Error).message);
          }
        }
        if (
          (action.action === "edit" || action.action === "steer") &&
          action.text !== undefined &&
          !action.text &&
          !uploads.length
        )
          throw new ControlPlaneStoreError(
            "invalid_request",
            "Input text cannot be empty without attachments",
          );
        if (
          uploads.some((file) => file.image) &&
          !(
            reviewedModel(source.provider, source.model_id)?.inputModalities as
              readonly string[] | undefined
          )?.includes("image")
        )
          throw new ControlPlaneStoreError(
            "invalid_request",
            "The selected model does not support image input",
          );
        const controlId = randomUUID();
        let targetRunId = source.id,
          targetTurnId = source.turn_id;
        const payload: Record<string, string | number> = {
          action: action.action,
          sourceRunId: source.id,
          sourceTurnId: turnId,
          queueOrder: number(session.row_version),
        };
        if (action.action === "edit") {
          await tx
            .updateTable("turns")
            .set({
              input_text: action.text,
              input_uploads: sql<unknown[]>`${JSON.stringify(uploads)}::jsonb`,
            })
            .where("id", "=", turnId)
            .where("tenant_id", "=", tenantId)
            .execute();
          await tx
            .updateTable("runs")
            .set({ row_version: sql`row_version+1`, updated_at: sql`clock_timestamp()` })
            .where("id", "=", source.id)
            .execute();
        } else if (action.action === "cancel") {
          await this.#cancel(tx, tenantId, source.id, turnId, "queued_input_cancelled");
        } else if (action.action === "move") {
          const other = await tx
            .selectFrom("runs as r")
            .innerJoin("turns as t", "t.id", "r.turn_id")
            .select(["r.id", "r.mailbox_position", "r.queued_steer_id"])
            .where("r.tenant_id", "=", tenantId)
            .where("r.session_id", "=", sessionId)
            .where(sql<boolean>`r.state='queued'`)
            .where("r.lease_id", "is", null)
            .where("r.input_return_request_id", "is", null)
            .where(
              "r.mailbox_position",
              action.direction === "up" ? "<" : ">",
              source.mailbox_position,
            )
            .orderBy("r.mailbox_position", action.direction === "up" ? "desc" : "asc")
            .limit(1)
            .forNoKeyUpdate(["r", "t"])
            .noWait()
            .executeTakeFirst();
          if (!other || other.queued_steer_id !== null) conflict();
          await sql`update runs set mailbox_position=case when id=${source.id}::uuid then ${other.mailbox_position}::bigint else ${source.mailbox_position}::bigint end,
            ready_at=null,row_version=row_version+1,updated_at=clock_timestamp()
            where tenant_id=${tenantId}::uuid and id in (${source.id}::uuid,${other.id}::uuid)`.execute(
            tx,
          );
          payload.direction = action.direction;
        } else {
          if (session.state !== "running") conflict();
          const target = await lockSteerTarget(tx, tenantId, sessionId, action.targetTurnId);
          if (
            uploads.some((file) => file.image) &&
            !(
              reviewedModel(target.provider, target.model_id)?.inputModalities as
                readonly string[] | undefined
            )?.includes("image")
          )
            throw new ControlPlaneStoreError(
              "invalid_request",
              "The active model does not support image input",
            );
          targetRunId = target.id;
          targetTurnId = target.turn_id;
          if (action.text !== undefined)
            await tx
              .updateTable("turns")
              .set({ input_text: action.text })
              .where("id", "=", turnId)
              .where("tenant_id", "=", tenantId)
              .execute();
          await holdQueuedSteer(tx, {
            controlId,
            tenantId,
            sessionId,
            targetRunId,
            targetTurnId,
            sourceRunId: source.id,
            sourceTurnId: turnId,
            idempotencyKey,
            requestSha256: hash,
            queueOrder: number(session.row_version),
            projectId: target.project_id,
            workspaceId: target.workspace_id,
            sandboxId: target.sandbox_id,
            piSessionId: session.pi_session_id,
          });
        }
        if (action.action !== "steer")
          await tx
            .insertInto("turn_control_requests")
            .values({
              id: controlId,
              tenant_id: tenantId,
              session_id: sessionId,
              turn_id: targetTurnId,
              target_run_id: targetRunId,
              idempotency_key: idempotencyKey,
              kind: "queue",
              state: "completed",
              request_sha256: hash,
              payload,
              attempts: 0,
              available_at: sql`clock_timestamp()`,
              dispatched_at: null,
              acknowledged_at: null,
              completed_at: sql`clock_timestamp()`,
              failure_code: null,
            })
            .execute();
        await this.#changed(tx, tenantId, sessionId);
        return false;
      });
    } catch (error) {
      if (busy(error)) conflict();
      throw error;
    }
    this.notifySession(tenantId, sessionId, action.action === "steer");
    return { queue: await this.list(tenantId, sessionId), replayed };
  }

  /** An explicit global pass remains useful for recovery tests. Runtime work is
   * Session-scoped and wakes on committed changes or a known retry deadline. */
  async reconcileOnce(scope?: QueueScope, current: () => boolean = () => true): Promise<void> {
    if (!current()) return;
    const heldKey = scope ? `${scope.tenantId}:${scope.sessionId}` : undefined;
    const knownWake = heldKey ? this.#held.get(heldKey) : undefined;
    let query = this.#database
      .selectFrom("runs as r")
      .innerJoin("turn_control_requests as c", "c.id", "r.queued_steer_id")
      .innerJoin("runs as target", "target.id", "c.target_run_id")
      .select(["r.id", "r.tenant_id", "r.session_id", "r.turn_id", "r.queued_steer_id"])
      .where(sql<boolean>`r.state='queued'`)
      .where("c.kind", "=", "queue")
      .whereRef("c.tenant_id", "=", "r.tenant_id")
      .whereRef("target.tenant_id", "=", "r.tenant_id")
      .whereRef("target.session_id", "=", "r.session_id")
      .where((eb) =>
        eb.or([
          consumedInput,
          eb("target.output_sealed_at", "is not", null),
          eb.and([
            eb("target.state", "=", "running"),
            acceptsSteer(sql.ref("target.id")),
            eb("c.state", "in", ["pending", "dispatched"]),
            eb("c.available_at", "<=", sql<Date>`clock_timestamp()`),
            sql<boolean>`not (${earlierDeliveryPending})`,
          ]),
        ]),
      )
      .orderBy("c.available_at", "asc")
      .limit(32);
    if (scope)
      query = query
        .where("r.tenant_id", "=", scope.tenantId)
        .where("r.session_id", "=", scope.sessionId);
    const rows = await query.execute();
    if (!current()) return;
    let failed = false;
    let index = 0;
    const work = async () => {
      while (!this.#closed && current() && index < rows.length) {
        const row = rows[index++]!;
        try {
          await this.#reconcile(row, current);
        } catch (error) {
          failed = true;
          /* Durable row remains pending for the next cycle. */
          if (!busy(error)) this.#recordFailure();
        }
      }
    };
    await Promise.all([work(), work()]);
    if (!scope || this.#closed || !current()) return;
    if (failed || rows.length === 32) {
      this.#schedule(scope, failed ? 1000 : 0);
      return;
    }
    const next = await this.#database
      .selectFrom("runs as r")
      .innerJoin("turn_control_requests as c", "c.id", "r.queued_steer_id")
      .innerJoin("runs as target", "target.id", "c.target_run_id")
      .innerJoin("sessions as s", "s.id", "r.session_id")
      .select([
        sql<number>`count(*)::int`.as("held"),
        sql<string | null>`extract(epoch from (min(c.available_at) filter (
          where target.state='running' and ${acceptsSteer(sql.ref("target.id"))}
            and c.state in ('pending','dispatched') and not (${earlierDeliveryPending})
        )-clock_timestamp()))*1000`.as("delay"),
      ])
      .where("r.tenant_id", "=", scope.tenantId)
      .where("r.session_id", "=", scope.sessionId)
      .whereRef("c.tenant_id", "=", "r.tenant_id")
      .whereRef("target.tenant_id", "=", "r.tenant_id")
      .whereRef("target.session_id", "=", "r.session_id")
      .where("r.state", "=", sql.lit("queued"))
      .where("s.pruned_at", "is", null)
      .where("c.kind", "=", "queue")
      .executeTakeFirstOrThrow();
    if (!current()) return;
    if (!next.held && heldKey && this.#held.get(heldKey) === knownWake) this.#held.delete(heldKey);
    if (next.delay !== null) this.#schedule(scope, Math.max(0, Number(next.delay)));
  }

  async #reconcile(
    source: {
      id: string;
      tenant_id: string;
      session_id: string;
      turn_id: string;
      queued_steer_id: string | null;
    },
    current: () => boolean,
  ): Promise<void> {
    const controlId = source.queued_steer_id!;
    const send = await this.#database.transaction().execute(async (tx) => {
      const session = await tx
        .selectFrom("sessions")
        .select(["id", "pruned_at"])
        .where("id", "=", source.session_id)
        .where("tenant_id", "=", source.tenant_id)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!session) return false;
      const input = await tx
        .selectFrom("runs as r")
        .innerJoin("turns as t", "t.id", "r.turn_id")
        .select(["r.state", "r.queued_steer_id", "r.input_return_request_id"])
        .where("r.id", "=", source.id)
        .where("r.tenant_id", "=", source.tenant_id)
        .forNoKeyUpdate(["r", "t"])
        .noWait()
        .executeTakeFirst();
      if (!input || input.state !== "queued" || input.queued_steer_id !== controlId) return false;
      // A single snapshot observes both the projected seal and all preceding
      // native entries; separate reads could incorrectly restore consumed input.
      const target = await tx
        .selectFrom("turn_control_requests as c")
        .innerJoin("runs as target", "target.id", "c.target_run_id")
        .select([
          "c.state",
          "target.output_sealed_at",
          "target.state as targetState",
          acceptsSteer(sql.ref("target.id")).as("acceptsSteer"),
          consumedInput.as("consumed"),
          earlierDeliveryPending.as("earlierPending"),
        ])
        .where("c.id", "=", controlId)
        .where("c.tenant_id", "=", source.tenant_id)
        .where("c.kind", "=", "queue")
        .executeTakeFirstOrThrow();
      if (target.consumed) {
        await this.#cancel(tx, source.tenant_id, source.id, source.turn_id, "queued_input_steered");
        await tx
          .updateTable("runs")
          .set({ input_return_request_id: null })
          .where("id", "=", source.id)
          .execute();
        await tx
          .updateTable("turn_control_requests")
          .set({ state: "completed", completed_at: sql`clock_timestamp()`, failure_code: null })
          .where("id", "=", controlId)
          .execute();
        await this.#changed(tx, source.tenant_id, source.session_id);
        return false;
      }
      if (target.output_sealed_at !== null) {
        if (input.input_return_request_id !== null)
          await this.#cancel(
            tx,
            source.tenant_id,
            source.id,
            source.turn_id,
            "queued_input_withdrawn",
          );
        await tx
          .updateTable("runs")
          .set({
            queued_steer_id: null,
            row_version: sql`row_version+1`,
            updated_at: sql`clock_timestamp()`,
          })
          .where("id", "=", source.id)
          .execute();
        await tx
          .updateTable("turn_control_requests")
          .set({
            state: "failed",
            completed_at: sql`clock_timestamp()`,
            failure_code: "steer_not_consumed",
          })
          .where("id", "=", controlId)
          .execute();
        await this.#changed(tx, source.tenant_id, source.session_id);
        return false;
      }
      if (
        input.input_return_request_id !== null ||
        target.state === "completed" ||
        target.state === "acknowledged" ||
        target.earlierPending ||
        !target.acceptsSteer ||
        session.pruned_at !== null ||
        target.targetState !== "running"
      )
        return false;
      // An attempt time bounds redundant replica sends. It is not effect
      // authority: stable native input identity makes overlapping retries safe.
      const attempt = await tx
        .updateTable("turn_control_requests")
        .set({
          attempts: sql`attempts+1`,
          available_at: sql`clock_timestamp()+interval '30 seconds'`,
        })
        .where("id", "=", controlId)
        .where("state", "in", ["pending", "dispatched"])
        .where("available_at", "<=", sql<Date>`clock_timestamp()`)
        .returning("id")
        .executeTakeFirst();
      return attempt !== undefined;
    });
    if (!send || this.#closed || !current()) return;
    try {
      await this.#steering.deliverQueued(controlId);
    } catch {
      await this.#database
        .updateTable("turn_control_requests")
        .set({
          available_at: sql`clock_timestamp()+make_interval(secs=>least(30,power(2,least(attempts,5))))`,
        })
        .where("id", "=", controlId)
        .where("state", "in", ["pending", "dispatched"])
        .execute();
    }
  }
}
