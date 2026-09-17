import { databaseTime, type Database } from "@pi-cloud/database";
import { releaseExecutionScope, releaseIdleSessionLease } from "./worker-family-capacity.ts";
import { transitionSandbox } from "@pi-cloud/domain";
import type { PiCloudMetrics } from "@pi-cloud/observability";
import {
  parseControlToSupervisorMessage,
  createExecutionReference,
  parseExecutionReference,
  parseSupervisorToControlMessage,
  type SupervisorHeartbeatAckMessage,
} from "@pi-cloud/protocol";
import { sql, type Kysely, type Transaction } from "kysely";
import type {
  TurnExecutionReference,
  TurnExecutionAuthority,
  TurnExecutionRequest,
} from "./run-executor.ts";
import {
  conflictingPiSessionWorker,
  lockPiSessionWorkerOwnership,
} from "./pi-session-worker-ownership.ts";

const DEFAULT_LEASE_DURATION_MS = 60_000;

export type SessionLeaseCoordinatorOptions = {
  database: Kysely<Database>;
  sandboxId: string;
  clock?: () => Date;
  idGenerator?: () => string;
  leaseDurationMs?: number;
  heartbeatConnectionId?: string;
  connectionGuard?: SupervisorConnectionGuard;
  metrics?: PiCloudMetrics;
};

export type SupervisorConnectionGuard = {
  controlPlaneInstanceId: string;
  transportId: string;
  heartbeatTimeoutMs: number;
};

export type SupervisorHeartbeatIdentity = {
  supervisorId: string;
  bootId: string;
  connectionId: string;
};

export class SessionLeaseCoordinatorError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "SessionLeaseCoordinatorError";
    this.code = code;
    this.retryable = retryable;
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("ExecutionReference coordinator clock must return a valid Date");
  }
  return value;
}

function safeInteger(value: string | number | bigint, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new SessionLeaseCoordinatorError(
      "session_lease_invariant",
      `${name} is outside the supported integer range`,
      false,
    );
  }
  return parsed;
}

function expectOne(updatedRows: bigint, description: string): void {
  if (updatedRows !== 1n) {
    throw new SessionLeaseCoordinatorError(
      "session_lease_invariant",
      `${description} changed ${updatedRows} rows`,
      false,
    );
  }
}

function requireUuid(value: string, name: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new TypeError(`${name} must be a UUID`);
  }
  return value;
}

type CurrentAssignmentRequest = Pick<
  TurnExecutionRequest,
  "tenantId" | "projectId" | "workspaceId" | "sessionId" | "runId" | "turnId" | "attemptId"
>;

export class SessionLeaseCoordinator implements TurnExecutionAuthority {
  readonly #database: Kysely<Database>;
  readonly #sandboxId: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #leaseDurationMs: number;
  readonly #heartbeatConnectionId: string;
  readonly #connectionGuard: SupervisorConnectionGuard | undefined;
  readonly #metrics: PiCloudMetrics | undefined;

  constructor(options: SessionLeaseCoordinatorOptions) {
    this.#database = options.database;
    this.#metrics = options.metrics;
    this.#sandboxId = options.sandboxId;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#leaseDurationMs = positiveInteger(
      options.leaseDurationMs ?? DEFAULT_LEASE_DURATION_MS,
      "leaseDurationMs",
    );
    this.#heartbeatConnectionId = requireUuid(
      options.heartbeatConnectionId ?? globalThis.crypto.randomUUID(),
      "heartbeatConnectionId",
    );
    this.#connectionGuard =
      options.connectionGuard === undefined
        ? undefined
        : {
            controlPlaneInstanceId: requireUuid(
              options.connectionGuard.controlPlaneInstanceId,
              "connectionGuard.controlPlaneInstanceId",
            ),
            transportId: requireUuid(
              options.connectionGuard.transportId,
              "connectionGuard.transportId",
            ),
            heartbeatTimeoutMs: positiveInteger(
              options.connectionGuard.heartbeatTimeoutMs,
              "connectionGuard.heartbeatTimeoutMs",
            ),
          };
  }

  get heartbeatIntervalMs(): number {
    return Math.max(1, Math.floor(this.#leaseDurationMs / 3));
  }

  async heartbeatIdentity(): Promise<SupervisorHeartbeatIdentity> {
    const sandbox = await this.#database
      .selectFrom("sandboxes")
      .select(["supervisor_id", "boot_id", "state"])
      .where("id", "=", this.#sandboxId)
      .executeTakeFirst();
    if (sandbox === undefined || sandbox.state === "terminated") {
      throw new SessionLeaseCoordinatorError(
        "sandbox_unavailable",
        "Heartbeat sandbox identity is unavailable",
        false,
      );
    }
    return {
      supervisorId: sandbox.supervisor_id,
      bootId: sandbox.boot_id,
      connectionId: this.#heartbeatConnectionId,
    };
  }

  async renewFromHeartbeat(value: unknown): Promise<SupervisorHeartbeatAckMessage> {
    const heartbeat = parseSupervisorToControlMessage(value);
    if (heartbeat.type !== "supervisor.heartbeat")
      throw new SessionLeaseCoordinatorError(
        "invalid_heartbeat",
        "Session renewal requires a Worker heartbeat",
        false,
      );
    if (heartbeat.payload.connectionId !== this.#heartbeatConnectionId)
      throw new SessionLeaseCoordinatorError(
        "stale_connection",
        "Worker heartbeat connection is stale",
        false,
      );
    const { renewals, now } = await this.#database.transaction().execute(async (tx) => {
      const worker = await tx
        .selectFrom("sandboxes")
        .selectAll()
        .where("id", "=", this.#sandboxId)
        .executeTakeFirst();
      if (
        !worker ||
        worker.supervisor_id !== heartbeat.payload.supervisorId ||
        worker.boot_id !== heartbeat.payload.bootId ||
        worker.max_concurrent_sessions !== heartbeat.payload.maxConcurrentSessions ||
        !["ready", "leased"].includes(worker.state)
      )
        throw new SessionLeaseCoordinatorError(
          "stale_supervisor",
          "Worker heartbeat identity is stale",
          false,
        );
      const connection = await this.#currentRegisteredConnection(
        tx,
        { supervisorId: worker.supervisor_id, bootId: worker.boot_id },
        false,
      );
      // One update per physical Session. Task progress/timeouts are not owner liveness.
      const families = heartbeat.payload.families;
      if (families.length) {
        await tx
          .selectFrom("session_leases")
          .select("lease_id")
          .where("sandbox_id", "=", this.#sandboxId)
          .where(
            "lease_id",
            "in",
            families.map((family) => family.leaseId),
          )
          .orderBy("lease_id")
          .forNoKeyUpdate()
          .execute();
      }
      if (connection) {
        const renewed = await tx
          .updateTable("supervisor_connections")
          .set({
            accepting_assignments: heartbeat.payload.acceptingAssignments,
            last_heartbeat_at: sql<Date>`clock_timestamp()`,
            expires_at: sql<Date>`clock_timestamp() + ${this.#connectionGuard!.heartbeatTimeoutMs} * interval '1 millisecond'`,
          })
          .where("connection_id", "=", this.#heartbeatConnectionId)
          .where("state", "=", "active")
          .where("expires_at", ">", sql<Date>`clock_timestamp()`)
          .executeTakeFirst();
        if (renewed.numUpdatedRows !== 1n)
          throw new SessionLeaseCoordinatorError(
            "stale_connection",
            "Worker connection expired during renewal",
            false,
          );
      }
      const rows =
        families.length === 0
          ? []
          : (
              await sql<{
                lease_id: string;
                fencing_token: string;
                valid_until: Date;
                renewed_at: Date;
              }>`
        with decision as materialized (select clock_timestamp() as at), reported as (
          select * from jsonb_to_recordset(${JSON.stringify(families)}::jsonb)
            as x("tenantId" uuid,"piSessionId" text,"leaseId" uuid,"writerId" uuid,"fencingToken" bigint)
        )
        update session_leases l set valid_until=d.at + ${this.#leaseDurationMs} * interval '1 millisecond', renewed_at=d.at
          from reported p,run_attempts w,decision d,sandboxes owner
         where l.lease_id=p."leaseId" and l.tenant_id=p."tenantId" and l.pi_session_id=p."piSessionId"
           and l.writer_id=p."writerId" and l.fencing_token=p."fencingToken" and l.sandbox_id=${this.#sandboxId}::uuid
           and l.valid_until>d.at and w.id=l.writer_id
           and owner.id=l.sandbox_id and owner.state in ('ready','leased')
           and w.native_writer_failed_at is null and w.native_writer_sealed_at is null
        returning l.lease_id,l.fencing_token,l.valid_until,l.renewed_at
      `.execute(tx)
            ).rows;
      const now = rows[0]?.renewed_at ?? (await databaseTime(tx));
      return {
        now,
        renewals: rows.map((r) => ({
          leaseId: r.lease_id,
          fencingToken: Number(r.fencing_token),
          validUntil: r.valid_until.toISOString(),
        })),
      };
    });
    const ack = parseControlToSupervisorMessage({
      protocolVersion: 1,
      messageId: this.#idGenerator(),
      sentAt: now.toISOString(),
      type: "supervisor.heartbeat.ack",
      payload: {
        acknowledgedMessageId: heartbeat.messageId,
        connectionId: heartbeat.payload.connectionId,
        familyLeaseRenewals: renewals,
      },
    });
    if (ack.type !== "supervisor.heartbeat.ack")
      throw new Error("Invalid heartbeat acknowledgement");
    return ack;
  }

  async quarantineSandbox(): Promise<void> {
    const now = validDate(this.#clock);
    await this.#database.transaction().execute(async (transaction) => {
      const sandbox = await transaction
        .selectFrom("sandboxes")
        .select(["state"])
        .where("id", "=", this.#sandboxId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (sandbox === undefined || sandbox.state === "failed" || sandbox.state === "terminated") {
        return;
      }
      await transaction
        .updateTable("sandboxes")
        .set({ state: transitionSandbox(sandbox.state, "failed"), updated_at: now })
        .where("id", "=", this.#sandboxId)
        .where("state", "=", sandbox.state)
        .executeTakeFirstOrThrow();
    });
  }

  async acquire(request: TurnExecutionRequest): Promise<TurnExecutionReference> {
    let previous = performance.now();
    const stages: Array<[string, number]> = [];
    const mark = (stage: string) => {
      const now = performance.now();
      stages.push([stage, (now - previous) / 1_000]);
      previous = now;
    };
    const granted = await this.#database.transaction().execute(async (tx) => {
      mark("lease_begin");
      const session = await tx
        .selectFrom("sessions")
        .selectAll()
        .where("id", "=", request.sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (
        !session ||
        session.tenant_id !== request.tenantId ||
        session.project_id !== request.projectId ||
        session.workspace_id !== request.workspaceId ||
        session.pi_session_id !== request.piSessionId
      )
        throw new SessionLeaseCoordinatorError(
          "session_unavailable",
          "Session is unavailable for execution",
          false,
        );
      if (!["cold", "idle"].includes(session.state))
        throw new SessionLeaseCoordinatorError(
          "invalid_state",
          "Session is not ready for execution",
          true,
        );
      mark("lease_session_lock");
      await lockPiSessionWorkerOwnership(tx, request.tenantId, request.piSessionId);
      mark("lease_family_lock");
      const attempt = await tx
        .selectFrom("run_attempts as a")
        .innerJoin("runs as r", "r.current_attempt_id", "a.id")
        .select([
          "a.id",
          "a.state",
          "a.lease_id",
          "a.claim_expires_at",
          "a.claim_owner_id",
          "a.native_writer_id",
          "r.state as runState",
        ])
        .where("a.id", "=", request.attemptId)
        .where("r.id", "=", request.runId)
        .where("r.session_id", "=", request.sessionId)
        .where("r.turn_id", "=", request.turnId)
        .where("a.tenant_id", "=", request.tenantId)
        .forUpdate(["a", "r"])
        .executeTakeFirst();
      if (
        !attempt ||
        attempt.state !== "claimed" ||
        attempt.runState !== "claimed" ||
        attempt.lease_id ||
        attempt.native_writer_id !== request.piSessionWriterId
      )
        throw new SessionLeaseCoordinatorError(
          "stale_attempt",
          "Run claim is unavailable for execution",
          false,
        );
      const conflict = await conflictingPiSessionWorker(tx, {
        tenantId: request.tenantId,
        piSessionId: request.piSessionId,
        expectedWorkerId: attempt.claim_owner_id,
      });
      if (conflict)
        throw new SessionLeaseCoordinatorError(
          "pi_session_owner_conflict",
          "Session belongs to another Worker",
          true,
        );
      mark("lease_attempt_owner");
      const worker = await tx
        .selectFrom("sandboxes")
        .selectAll()
        .where("id", "=", this.#sandboxId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!worker || !["ready", "leased"].includes(worker.state))
        throw new SessionLeaseCoordinatorError(
          "sandbox_unavailable",
          "Worker is unavailable",
          true,
        );
      mark("lease_worker_lock");
      await this.#currentRegisteredConnection(
        tx,
        { supervisorId: worker.supervisor_id, bootId: worker.boot_id },
        true,
      );
      mark("lease_connection");
      let lease = await tx
        .selectFrom("session_leases")
        .selectAll()
        .where("tenant_id", "=", request.tenantId)
        .where("pi_session_id", "=", request.piSessionId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      const now = await databaseTime(tx);
      if (attempt.claim_expires_at <= now)
        throw new SessionLeaseCoordinatorError(
          "stale_attempt",
          "Run claim expired during acquisition",
          false,
        );
      if (
        lease &&
        (lease.sandbox_id !== worker.id ||
          lease.writer_id !== request.piSessionWriterId ||
          lease.valid_until <= now)
      )
        throw new SessionLeaseCoordinatorError(
          "session_lease_conflict",
          "Previous Session owner must finish closure before takeover",
          true,
        );
      const newFamily = !lease;
      mark("lease_read");
      if (!lease) {
        if (worker.active_sessions >= worker.max_concurrent_sessions)
          throw new SessionLeaseCoordinatorError(
            "capacity",
            "Worker Session capacity is full",
            true,
          );
        const physical = await tx
          .selectFrom("pi_sessions")
          .select("lease_epoch")
          .where("tenant_id", "=", request.tenantId)
          .where("id", "=", request.piSessionId)
          .executeTakeFirstOrThrow();
        const epoch = Number(physical.lease_epoch) + 1;
        if (!Number.isSafeInteger(epoch)) throw new Error("Session execution epoch exhausted");
        await tx
          .updateTable("pi_sessions")
          .set({ lease_epoch: epoch })
          .where("tenant_id", "=", request.tenantId)
          .where("id", "=", request.piSessionId)
          .execute();
        lease = await tx
          .insertInto("session_leases")
          .values({
            tenant_id: request.tenantId,
            pi_session_id: request.piSessionId,
            lease_id: this.#idGenerator(),
            sandbox_id: worker.id,
            writer_id: request.piSessionWriterId,
            fencing_token: epoch,
            valid_until: sql<Date>`clock_timestamp() + ${this.#leaseDurationMs} * interval '1 millisecond'`,
            acquired_at: sql<Date>`clock_timestamp()`,
            renewed_at: sql<Date>`clock_timestamp()`,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
      }
      await tx
        .updateTable("sessions")
        .set({ row_version: sql<string>`row_version+1`, updated_at: now })
        .where("id", "=", request.sessionId)
        .execute();
      await tx
        .updateTable("sandboxes")
        .set({
          state: "leased",
          active_sessions: worker.active_sessions + (newFamily ? 1 : 0),
          updated_at: now,
        })
        .where("id", "=", worker.id)
        .execute();
      const bound = await tx
        .updateTable("run_attempts")
        .set({
          sandbox_id: worker.id,
          lease_id: lease.lease_id,
          fencing_token: lease.fencing_token,
          execution_released_at: null,
          updated_at: now,
        })
        .where("id", "=", request.attemptId)
        .where("state", "=", "claimed")
        .where("lease_id", "is", null)
        .where("claim_expires_at", ">", sql<Date>`clock_timestamp()`)
        .where(
          sql<boolean>`(${this.#connectionGuard === undefined} or exists(
          select 1 from supervisor_connections where connection_id=${this.#heartbeatConnectionId}::uuid
            and state='active' and accepting_assignments and expires_at>clock_timestamp()
        ))`,
        )
        .where(
          sql<boolean>`exists(select 1 from session_leases where lease_id=${lease.lease_id}::uuid and valid_until>clock_timestamp())`,
        )
        .executeTakeFirst();
      expectOne(bound.numUpdatedRows, "binding a task to its Session lease");
      mark("lease_write");
      return {
        executionReference: createExecutionReference(
          lease.lease_id,
          request.attemptId,
          Number(lease.fencing_token),
        ),
      };
    });
    mark("lease_commit");
    // Successful phases partition the outer execution_lease duration. Begin
    // includes pool acquisition/BEGIN; commit includes client handoff, not only fsync.
    // Observe after commit so a rolled-back grant cannot look successfully acquired.
    for (const [stage, seconds] of stages)
      this.#metrics?.runPreparationDuration.observe({ stage, outcome: "completed" }, seconds);
    return granted;
  }

  async assertCurrent(
    transaction: Transaction<Database>,
    request: TurnExecutionRequest,
    acknowledgement: TurnExecutionReference,
  ): Promise<void> {
    await this.#currentGrant(transaction, request, acknowledgement, true);
  }

  async assertCurrentOrExpired(
    transaction: Transaction<Database>,
    request: TurnExecutionRequest,
    acknowledgement: TurnExecutionReference,
  ): Promise<void> {
    await this.#currentGrant(transaction, request, acknowledgement, false);
  }

  async assertCurrentGrant(
    request: TurnExecutionRequest,
    acknowledgement: TurnExecutionReference,
  ): Promise<void> {
    await this.#database.transaction().execute(async (transaction) => {
      await this.#currentGrant(transaction, request, acknowledgement, true);
    });
  }

  async currentAssignment(request: CurrentAssignmentRequest): Promise<TurnExecutionReference> {
    return this.#database.transaction().execute(async (transaction) => {
      const session = await transaction
        .selectFrom("sessions")
        .select(["tenant_id", "project_id", "workspace_id", "state"])
        .where("id", "=", request.sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (
        session === undefined ||
        session.tenant_id !== request.tenantId ||
        session.project_id !== request.projectId ||
        session.workspace_id !== request.workspaceId
      ) {
        throw new SessionLeaseCoordinatorError(
          "session_unavailable",
          "Session is unavailable for cancellation",
          false,
        );
      }
      if (session.state !== "running") {
        throw new SessionLeaseCoordinatorError(
          "invalid_state",
          "Session no longer has an active execution to cancel",
          false,
        );
      }

      const grant = await transaction
        .selectFrom("active_execution_scopes")
        .selectAll()
        .where("session_id", "=", request.sessionId)
        .where("valid_until", ">", sql<Date>`clock_timestamp()`)
        .executeTakeFirst();
      const generation =
        grant === undefined
          ? -1
          : safeInteger(grant.fencing_token, "ExecutionReference fencing token");
      if (
        grant === undefined ||
        grant.sandbox_id !== this.#sandboxId ||
        grant.tenant_id !== request.tenantId ||
        grant.project_id !== request.projectId ||
        grant.workspace_id !== request.workspaceId ||
        grant.run_id !== request.runId ||
        grant.turn_id !== request.turnId ||
        grant.attempt_id !== request.attemptId
      ) {
        throw new SessionLeaseCoordinatorError(
          "stale_session_lease",
          "ExecutionReference is stale",
          false,
        );
      }
      return {
        executionReference: createExecutionReference(grant.lease_id, grant.attempt_id, generation),
      };
    });
  }

  async releaseCurrent(
    transaction: Transaction<Database>,
    request: TurnExecutionRequest,
    acknowledgement: TurnExecutionReference,
    now: Date,
  ): Promise<void> {
    await this.#currentGrant(transaction, request, acknowledgement, false);
    const identity = parseExecutionReference(acknowledgement.executionReference);
    await releaseExecutionScope(transaction, {
      tenantId: request.tenantId,
      attemptId: identity.attemptId,
      leaseId: identity.leaseId,
      fencingToken: identity.fencingToken,
      now,
    });
  }

  async releaseAcquired(
    request: TurnExecutionRequest,
    acknowledgement: TurnExecutionReference,
  ): Promise<void> {
    const now = validDate(this.#clock);
    await this.#database.transaction().execute(async (transaction) => {
      await this.releaseCurrent(transaction, request, acknowledgement, now);
    });
  }

  async releaseUnboundClaim(
    tx: Transaction<Database>,
    request: TurnExecutionRequest,
    now: Date,
  ): Promise<void> {
    await lockPiSessionWorkerOwnership(tx, request.tenantId, request.piSessionId);
    const lease = await tx
      .selectFrom("session_leases")
      .select("lease_id")
      .where("tenant_id", "=", request.tenantId)
      .where("pi_session_id", "=", request.piSessionId)
      .where("writer_id", "=", request.piSessionWriterId)
      .where("sandbox_id", "=", this.#sandboxId)
      .executeTakeFirst();
    if (lease) await releaseIdleSessionLease(tx, lease.lease_id, now);
  }

  async #currentGrant(
    transaction: Transaction<Database>,
    request: TurnExecutionRequest,
    acknowledgement: TurnExecutionReference,
    requireUnexpired: boolean,
  ) {
    const identity = parseExecutionReference(acknowledgement.executionReference);
    if (identity.attemptId !== request.attemptId) {
      throw new SessionLeaseCoordinatorError(
        "stale_session_lease",
        "ExecutionReference belongs to another Run execution",
        false,
      );
    }
    await transaction
      .selectFrom("session_leases")
      .select("lease_id")
      .where("lease_id", "=", identity.leaseId)
      .forKeyShare()
      .executeTakeFirst();
    const grant = await transaction
      .selectFrom("active_execution_scopes")
      .selectAll()
      .where("session_id", "=", request.sessionId)
      .where("lease_id", "=", identity.leaseId)
      .where("fencing_token", "=", String(identity.fencingToken))
      .where(sql<boolean>`(${!requireUnexpired} or valid_until > clock_timestamp())`)
      .executeTakeFirst();
    if (
      grant === undefined ||
      grant.tenant_id !== request.tenantId ||
      grant.project_id !== request.projectId ||
      grant.workspace_id !== request.workspaceId ||
      grant.run_id !== request.runId ||
      grant.turn_id !== request.turnId ||
      grant.attempt_id !== request.attemptId ||
      grant.sandbox_id !== this.#sandboxId
    ) {
      throw new SessionLeaseCoordinatorError(
        "stale_session_lease",
        "ExecutionReference is stale",
        false,
      );
    }
    return grant;
  }

  async #currentRegisteredConnection(
    transaction: Transaction<Database>,
    identity: { supervisorId: string; bootId: string },
    requireAcceptingAssignments: boolean,
  ): Promise<{ acceptingAssignments: boolean } | undefined> {
    if (this.#connectionGuard === undefined) return undefined;
    const connection = await transaction
      .selectFrom("supervisor_connections")
      .select([
        "sandbox_id",
        "supervisor_id",
        "boot_id",
        "control_plane_instance_id",
        "transport_id",
        "state",
        "accepting_assignments",
        "expires_at",
      ])
      .where("connection_id", "=", this.#heartbeatConnectionId)
      .forUpdate()
      .executeTakeFirst();
    const now = await databaseTime(transaction);
    if (
      connection === undefined ||
      connection.sandbox_id !== this.#sandboxId ||
      connection.supervisor_id !== identity.supervisorId ||
      connection.boot_id !== identity.bootId ||
      connection.control_plane_instance_id !== this.#connectionGuard.controlPlaneInstanceId ||
      connection.transport_id !== this.#connectionGuard.transportId ||
      connection.state !== "active" ||
      new Date(connection.expires_at).valueOf() <= now.valueOf()
    ) {
      throw new SessionLeaseCoordinatorError(
        "stale_connection",
        "Supervisor connection is stale",
        false,
      );
    }
    if (requireAcceptingAssignments && !connection.accepting_assignments) {
      throw new SessionLeaseCoordinatorError(
        "connection_not_accepting",
        "Supervisor connection is not accepting assignments",
        true,
      );
    }
    return { acceptingAssignments: connection.accepting_assignments };
  }
}
