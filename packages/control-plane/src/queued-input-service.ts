import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely, type Selectable } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  assertUserInputBudget,
  reviewedModel,
  parseUserUploads,
  parseInputQueueResource,
  type AcceptTurnRequest,
  type AcceptedConversationInputResource,
  type NativeInputAccepted,
  type NativeInputCommand,
  type NativeInputResult,
  type NativeInputSnapshot,
  type InputQueueResource,
  type QueuedInputAction,
  type QueuedInputActionResult,
  type AcknowledgeReturnedInputs,
  type UserUpload,
} from "@pi-cloud/protocol";
import {
  readNativeHumanInputs,
  readNativeHumanSubmission,
} from "@pi-cloud/pi-session-postgres/durable";
import { SessionLeaseCoordinator } from "@pi-cloud/runtime-core/session-lease-coordinator";
import { advanceLaneReadiness } from "@pi-cloud/runtime-core/run-readiness";
import { readInputQueue, pgInputRevision, queueViewVersion } from "./input-queue-snapshot.ts";
import { readReturnedInputs } from "./stopped-inputs.ts";
import { bindInputUploads } from "./workspace-upload-service.ts";
import type { ControlPlaneStore } from "./control-plane-store.ts";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";

export interface NativeInputBackend {
  humanInput(command: NativeInputCommand): Promise<NativeInputResult>;
}
export type NativeInputBackendFactory = (workerId: string) => Promise<NativeInputBackend>;
const hash = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const nativeHumanInputId = (tenantId: string, sessionId: string, key: string): string =>
  `input-${hash(["pi-cloud.human-input.v1", tenantId, sessionId, key])}`;
const mutationId = (tenantId: string, sessionId: string, key: string): string =>
  `edit-${hash(["pi-cloud.human-edit.v1", tenantId, sessionId, key])}`;
function conflict(message: string): never {
  throw new ControlPlaneStoreError("conflict", message);
}
function unavailable(): never {
  throw new ControlPlaneStoreError(
    "input_delivery_unavailable",
    "The Agent cannot confirm this input yet; keep the draft and retry",
  );
}
const columns = [
  "id",
  "turn_id",
  "tenant_id",
  "session_id",
  "workspace_id",
  "project_id",
  "provider",
  "model_id",
  "thinking_level",
  "working_directory",
  "worker_id",
  "state",
  "lease_id",
  "output_seal_id",
  "output_sealed_at",
  "row_version",
  "mailbox_position",
] as const;
type InputTarget = Pick<Selectable<Database["runs"]>, (typeof columns)[number]>;
type WithoutGrant<T> = T extends unknown ? Omit<T, "executionReference"> : never;

/** Native inputs have one durable owner. PG retains only initial execution work and controls. */
export class QueuedInputService {
  constructor(
    readonly options: { database: Kysely<Database>; backendFactory?: NativeInputBackendFactory },
  ) {}

  async #session(db: Kysely<Database>, tenantId: string, sessionId: string, lock = false) {
    const row = await db
      .selectFrom("sessions")
      .select(["id", "row_version", "state", "session_kind", "pi_session_id", "pi_conversation_id"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", sessionId)
      .where("pruned_at", "is", null)
      .$if(lock, (q) => q.forNoKeyUpdate())
      .executeTakeFirst();
    if (!row || row.session_kind !== "conversation")
      throw new ControlPlaneStoreError("not_found", "Conversation was not found");
    return row;
  }
  async #run(db: Kysely<Database>, tenantId: string, sessionId: string, runId?: string) {
    return db
      .selectFrom("runs")
      .select(columns)
      .where("tenant_id", "=", tenantId)
      .where("session_id", "=", sessionId)
      .$if(runId !== undefined, (q) => q.where("id", "=", runId!))
      .orderBy("mailbox_position", "desc")
      .limit(1)
      .executeTakeFirst();
  }
  async #assertReceiving(
    db: Kysely<Database>,
    target: { id: string; state: string; worker_id: string | null },
  ) {
    if (target.state !== "running" || !target.worker_id) unavailable();
    const stop = await db
      .selectFrom("turn_control_requests")
      .select("id")
      .where("target_run_id", "=", target.id)
      .where("kind", "=", "cancel")
      .where("state", "in", ["pending", "dispatched", "acknowledged"])
      .limit(1)
      .executeTakeFirst();
    if (stop) conflict("The Run is stopping and no longer accepts input");
  }
  #validate(
    text: string,
    uploads: readonly UserUpload[],
    model: { provider: string; model_id: string },
  ) {
    if (!text.trim() && !uploads.length)
      throw new ControlPlaneStoreError("invalid_request", "Input is empty");
    try {
      assertUserInputBudget(text, uploads);
    } catch (error) {
      throw new ControlPlaneStoreError(
        "invalid_request",
        error instanceof Error ? error.message : "Invalid input",
      );
    }
    if (
      uploads.some((u) => u.image) &&
      !(
        reviewedModel(model.provider, model.model_id)?.inputModalities as
          readonly string[] | undefined
      )?.includes("image")
    )
      throw new ControlPlaneStoreError(
        "invalid_request",
        "The active model does not support images",
      );
  }
  async #deliver(
    target: InputTarget,
    command: WithoutGrant<NativeInputCommand>,
  ): Promise<NativeInputResult> {
    const workerId = target.worker_id,
      backendFactory = this.options.backendFactory;
    if (!workerId || !backendFactory) unavailable();
    try {
      const grant = await new SessionLeaseCoordinator({
        database: this.options.database,
        sandboxId: workerId,
      }).currentAssignment({
        tenantId: target.tenant_id,
        projectId: target.project_id,
        workspaceId: target.workspace_id,
        sessionId: target.session_id,
        runId: target.id,
        turnId: target.turn_id,
      });
      const backend = await backendFactory(workerId);
      return await backend.humanInput({
        ...command,
        executionReference: grant.executionReference,
      } as NativeInputCommand);
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
      if (code === "idempotency_conflict")
        throw new ControlPlaneStoreError(code, "Input identity was reused for another operation");
      if (["input_conflict", "input_closed"].includes(code))
        conflict("The input changed or has already been consumed");
      unavailable();
    }
  }
  async #changed(tenantId: string, sessionId: string): Promise<void> {
    // A view wake does not own acceptance. Native publication remains authoritative.
    await sql`select pi_cloud_input_queue_change(${tenantId}::uuid,${sessionId}::uuid)`
      .execute(this.options.database)
      .catch(() => {});
  }

  async accept(
    store: ControlPlaneStore,
    tenantId: string,
    sessionId: string,
    key: string,
    request: AcceptTurnRequest,
    delivery: "follow_up" | "steer" = "follow_up",
    targetTurnId?: string,
  ): Promise<AcceptedConversationInputResource> {
    const inputId = nativeHumanInputId(tenantId, sessionId, key);
    const fingerprint = hash({
      delivery,
      targetTurnId: targetTurnId ?? null,
      prompt: request.prompt,
      uploadIds: request.uploadIds ?? [],
      thinkingLevel: request.thinkingLevel ?? null,
    });
    const decision = await store.withInputAdmission(
      sessionId,
      key,
      request,
      async ({
        transaction: tx,
        tenantId: admittedTenantId,
        session,
        hasAcceptedRun,
        acceptInitial,
      }) => {
        if (admittedTenantId !== tenantId)
          throw new ControlPlaneStoreError("not_found", "Conversation was not found");
        if (hasAcceptedRun) {
          if (delivery !== "follow_up")
            throw new ControlPlaneStoreError(
              "idempotency_conflict",
              "Identity already belongs to an initial request",
            );
          return { accepted: await acceptInitial() };
        }
        if (session.pi_conversation_id !== null) {
          const scope = {
            tenantId,
            sessionId: session.pi_session_id,
            conversationId: Number(session.pi_conversation_id),
          };
          const previous = await readNativeHumanSubmission(tx, scope, inputId);
          if (previous?.runId) {
            const state = await readNativeHumanInputs(tx, { ...scope, runId: previous.runId });
            const record = state.state.inputs[inputId];
            if (!record || record.fingerprint !== fingerprint)
              throw new ControlPlaneStoreError("idempotency_conflict", "Input identity was reused");
            const run = await this.#run(tx, tenantId, sessionId, previous.runId);
            if (!run) throw new Error("Native input lost its Run");
            return {
              accepted: {
                kind: "input",
                inputId,
                sessionId,
                runId: run.id,
                turnId: run.turn_id,
                delivery,
                state: "accepted",
                acceptedAt: record.acceptedAt,
                replayed: true,
              } as NativeInputAccepted,
            };
          }
        }
        const target = await this.#run(tx, tenantId, sessionId);
        if (
          !target ||
          (["completed", "failed", "cancelled", "timed_out"].includes(target.state) &&
            (target.lease_id === null || target.output_sealed_at !== null))
        ) {
          if (delivery === "steer") conflict("There is no running Agent to steer");
          return { accepted: await acceptInitial() };
        }
        await this.#assertReceiving(tx, target);
        if (targetTurnId !== undefined && target.turn_id !== targetTurnId)
          conflict("The target Run changed");
        if (request.thinkingLevel !== undefined && request.thinkingLevel !== target.thinking_level)
          conflict("An additional input uses the current Run's model settings");
        const uploads = await bindInputUploads(tx, {
          tenantId,
          sessionId,
          workspaceId: target.workspace_id,
          workingDirectory: target.working_directory,
          ids: request.uploadIds ?? [],
        });
        this.#validate(request.prompt, uploads, target);
        return { target, uploads };
      },
    );
    if (decision.accepted) return decision.accepted;
    const acceptedAt = new Date().toISOString();
    const result = await this.#deliver(decision.target!, {
      action: "submit",
      tenantId,
      sessionId,
      runId: decision.target!.id,
      input: {
        inputId,
        idempotencyKey: key,
        fingerprint,
        text: request.prompt,
        uploads: decision.uploads!,
        mode: delivery,
        acceptedAt,
      },
    });
    if (!result.acceptedAt)
      throw new ControlPlaneStoreError(
        "input_delivery_unavailable",
        "Input confirmation was incomplete; retry the same draft",
      );
    return {
      kind: "input",
      inputId,
      sessionId,
      runId: decision.target!.id,
      turnId: decision.target!.turn_id,
      delivery,
      state: "accepted",
      acceptedAt: result.acceptedAt,
      replayed: result.replayed,
    };
  }

  list(
    tenantId: string,
    sessionId: string,
    page: { afterPosition?: number; revision?: string } = {},
  ) {
    return readInputQueue(this.options.database, tenantId, sessionId, page);
  }

  async #nativeView(
    tenantId: string,
    sessionId: string,
    targetTurnId: string,
    native: NativeInputSnapshot,
  ): Promise<InputQueueResource> {
    return this.options.database
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute(async (tx) => {
        const session = await this.#session(tx, tenantId, sessionId);
        const pending = await tx
          .selectFrom("runs")
          .select(["id", "turn_id", "mailbox_position", "row_version"])
          .where("tenant_id", "=", tenantId)
          .where("session_id", "=", sessionId)
          .where("state", "=", "queued")
          .where("lease_id", "is", null)
          .where("started_at", "is", null)
          .where("pruned_at", "is", null)
          .orderBy("mailbox_position")
          .execute();
        const returned = await tx
          .selectFrom("turn_control_requests")
          .select("id")
          .where("tenant_id", "=", tenantId)
          .where("session_id", "=", sessionId)
          .where("kind", "=", "cancel")
          .where(sql<string>`payload->>'inputReturnPending'`, "=", "true")
          .limit(1)
          .executeTakeFirst();
        const selected = native.hasMore ? [] : pending.slice(0, 20 - native.items.length);
        const bodies = selected.length
          ? await tx
              .selectFrom("runs")
              .select(["id", "turn_id", "input_text", "input_uploads", "created_at"])
              .where("tenant_id", "=", tenantId)
              .where(
                "id",
                "in",
                selected.map((r) => r.id),
              )
              .orderBy("mailbox_position")
              .execute()
          : [];
        const items = [
          ...native.items.map(({ idempotencyKey: _key, ...item }) => ({
            ...item,
            runId: native.runId,
          })),
          ...bodies.map((r) => ({
            inputId: r.turn_id,
            runId: r.id,
            text: r.input_text,
            uploads: parseUserUploads(r.input_uploads),
            acceptedAt: r.created_at.toISOString(),
            mailboxPosition: 0,
            status: "queued" as const,
          })),
        ].map((item, index) => ({ ...item, mailboxPosition: index + 1 }));
        return parseInputQueueResource({
          sessionId,
          activeTurnId: session.state === "running" ? targetTurnId : null,
          revision: `${native.revision}.${pgInputRevision(pending)}`,
          viewVersion: queueViewVersion(native.nativeSequence, session.row_version),
          hasReturnedInputs: returned !== undefined,
          afterPosition: 0,
          hasMore: native.hasMore || native.items.length + pending.length > 20,
          items: items.slice(0, 20),
        });
      });
  }

  async mutate(
    tenantId: string,
    sessionId: string,
    inputId: string,
    key: string,
    request: QueuedInputAction,
  ): Promise<QueuedInputActionResult> {
    if (!inputId.startsWith("input-"))
      return this.#mutateInitial(tenantId, sessionId, inputId, key, request);
    const operationId = mutationId(tenantId, sessionId, key),
      fingerprint = hash({ inputId, request });
    const session = await this.#session(this.options.database, tenantId, sessionId);
    if (session.pi_conversation_id === null) unavailable();
    const scope = {
      tenantId,
      sessionId: session.pi_session_id,
      conversationId: Number(session.pi_conversation_id),
    };
    const submission = await readNativeHumanSubmission(this.options.database, scope, inputId);
    const target = await this.#run(this.options.database, tenantId, sessionId, submission?.runId);
    if (!target) conflict("Input target is unavailable");
    const stored = await readNativeHumanInputs(this.options.database, {
      ...scope,
      runId: target.id,
    });
    const receipt = stored.state.receipts[operationId];
    if (receipt) {
      if (receipt.fingerprint !== fingerprint)
        throw new ControlPlaneStoreError("idempotency_conflict", "Edit identity was reused");
      return { queue: await this.list(tenantId, sessionId), replayed: true };
    }
    await this.#assertReceiving(this.options.database, target);
    let uploads: UserUpload[] | undefined;
    if (request.action === "edit" && request.uploadIds !== undefined)
      uploads = await this.options.database.transaction().execute((tx) =>
        bindInputUploads(tx, {
          tenantId,
          sessionId,
          workspaceId: target.workspace_id,
          workingDirectory: target.working_directory,
          ids: request.uploadIds!,
        }),
      );
    if ((request.action === "edit" || request.action === "steer") && request.text !== undefined)
      this.#validate(
        request.text,
        uploads ?? parseUserUploads(stored.state.inputs[inputId]?.uploads ?? []),
        target,
      );
    const change =
      request.action === "edit"
        ? { action: request.action, text: request.text.trim(), ...(uploads ? { uploads } : {}) }
        : request.action === "move"
          ? { action: request.action, direction: request.direction }
          : request.action === "steer"
            ? {
                action: request.action,
                ...(request.text === undefined ? {} : { text: request.text.trim() }),
              }
            : { action: request.action };
    const result = await this.#deliver(target, {
      action: "mutate",
      tenantId,
      sessionId,
      runId: target.id,
      mutation: {
        operationId,
        fingerprint,
        inputId,
        revision: request.revision.split(".")[0]!,
        change,
      },
    });
    return {
      replayed: result.replayed,
      queue: await this.#nativeView(tenantId, sessionId, target.turn_id, result.queue),
    };
  }

  async #mutateInitial(
    tenantId: string,
    sessionId: string,
    inputId: string,
    key: string,
    request: QueuedInputAction,
  ): Promise<QueuedInputActionResult> {
    const fingerprint = hash({ inputId, request });
    const replayed = await this.options.database
      .transaction()
      .execute(async (tx) => {
        await this.#session(tx, tenantId, sessionId, true);
        const existing = await tx
          .selectFrom("turn_control_requests")
          .select("request_sha256")
          .where("tenant_id", "=", tenantId)
          .where("session_id", "=", sessionId)
          .where("idempotency_key", "=", key)
          .executeTakeFirst();
        if (existing) {
          if (existing.request_sha256 !== fingerprint)
            throw new ControlPlaneStoreError("idempotency_conflict", "Edit identity was reused");
          return true;
        }
        const run = await tx
          .selectFrom("runs")
          .selectAll()
          .where("tenant_id", "=", tenantId)
          .where("session_id", "=", sessionId)
          .where("turn_id", "=", inputId)
          .forNoKeyUpdate()
          .noWait()
          .executeTakeFirst();
        if (!run || run.state !== "queued" || run.lease_id !== null || run.started_at !== null)
          conflict("The input has already started");
        const rows = await tx
          .selectFrom("runs")
          .select(["turn_id", "row_version", "mailbox_position"])
          .where("tenant_id", "=", tenantId)
          .where("session_id", "=", sessionId)
          .where("state", "=", "queued")
          .where("lease_id", "is", null)
          .where("started_at", "is", null)
          .where("pruned_at", "is", null)
          .orderBy("mailbox_position")
          .execute();
        if (pgInputRevision(rows) !== request.revision.split(".")[1])
          conflict("The pending queue changed");
        if (request.action === "steer")
          conflict("An unstarted execution has no running Agent to steer");
        if (request.action === "edit") {
          const uploads =
            request.uploadIds === undefined
              ? parseUserUploads(run.input_uploads)
              : await bindInputUploads(tx, {
                  tenantId,
                  sessionId,
                  workspaceId: run.workspace_id,
                  workingDirectory: run.working_directory,
                  ids: request.uploadIds,
                });
          this.#validate(request.text, uploads, run);
          await tx
            .updateTable("runs")
            .set({
              input_text: request.text.trim(),
              input_uploads: sql`${JSON.stringify(uploads)}::jsonb`,
              row_version: sql`row_version+1`,
              updated_at: sql`clock_timestamp()`,
            })
            .where("id", "=", run.id)
            .execute();
        } else if (request.action === "cancel") {
          await tx
            .updateTable("runs")
            .set({
              state: "cancelled",
              ready_at: null,
              settled_at: sql`clock_timestamp()`,
              stop_reason: "queued_input_cancelled",
              row_version: sql`row_version+1`,
              updated_at: sql`clock_timestamp()`,
            })
            .where("id", "=", run.id)
            .execute();
          await tx
            .insertInto("run_transitions")
            .values({
              id: randomUUID(),
              tenant_id: tenantId,
              run_id: run.id,
              from_state: "queued",
              to_state: "cancelled",
              reason: "queued_input_cancelled",
              occurred_at: sql`clock_timestamp()`,
            })
            .execute();
        } else {
          const at = rows.findIndex((r) => r.turn_id === inputId),
            other = rows[at + (request.direction === "up" ? -1 : 1)];
          if (!other) conflict("The input cannot move further");
          const locked = await tx
            .selectFrom("runs")
            .select("id")
            .where("tenant_id", "=", tenantId)
            .where("turn_id", "=", other.turn_id)
            .where("state", "=", "queued")
            .where("lease_id", "is", null)
            .forNoKeyUpdate()
            .noWait()
            .executeTakeFirst();
          if (!locked) conflict("The pending queue changed");
          await sql`update runs set mailbox_position=case when id=${run.id}::uuid then ${other.mailbox_position}::bigint else ${run.mailbox_position}::bigint end,
          ready_at=null,row_version=row_version+1,updated_at=clock_timestamp() where id in (${run.id}::uuid,${locked.id}::uuid)`.execute(
            tx,
          );
        }
        await tx
          .insertInto("turn_control_requests")
          .values({
            id: randomUUID(),
            tenant_id: tenantId,
            session_id: sessionId,
            turn_id: run.turn_id,
            target_run_id: run.id,
            idempotency_key: key,
            kind: "queue",
            state: "completed",
            request_sha256: fingerprint,
            payload: { action: request.action, inputId },
            attempts: 0,
            available_at: sql`clock_timestamp()`,
            dispatched_at: null,
            acknowledged_at: null,
            completed_at: sql`clock_timestamp()`,
            failure_code: null,
          })
          .execute();
        await tx
          .updateTable("sessions")
          .set({ row_version: sql`row_version+1`, updated_at: sql`clock_timestamp()` })
          .where("id", "=", sessionId)
          .execute();
        await advanceLaneReadiness(tx, tenantId, sessionId);
        return false;
      })
      .catch((error: unknown) => {
        if (
          error &&
          typeof error === "object" &&
          "code" in error &&
          ["55P03", "40001", "40P01"].includes(String(error.code))
        )
          conflict("The input is being claimed or changed; refresh before saving");
        throw error;
      });
    return { queue: await this.list(tenantId, sessionId), replayed };
  }

  returned(
    tenantId: string,
    sessionId: string,
    page: { requestId?: string; afterPosition?: number } = {},
  ) {
    return readReturnedInputs(this.options.database, tenantId, sessionId, page);
  }
  async acknowledgeReturned(
    tenantId: string,
    sessionId: string,
    request: AcknowledgeReturnedInputs,
  ): Promise<void> {
    await this.options.database.transaction().execute(async (tx) => {
      await this.#session(tx, tenantId, sessionId, true);
      const batch = await readReturnedInputs(tx, tenantId, sessionId, {
        requestId: request.requestId,
      });
      if (batch.pending) conflict("The stopped inputs have not finished settling");
      const result = await tx
        .updateTable("turn_control_requests")
        .set({ payload: sql`payload || '{"inputReturnPending":false}'::jsonb` })
        .where("tenant_id", "=", tenantId)
        .where("session_id", "=", sessionId)
        .where("id", "=", request.requestId)
        .where("kind", "=", "cancel")
        .executeTakeFirst();
      if (result.numUpdatedRows !== 1n)
        throw new ControlPlaneStoreError("not_found", "Stopped input batch was not found");
    });
    await this.#changed(tenantId, sessionId);
  }
}
