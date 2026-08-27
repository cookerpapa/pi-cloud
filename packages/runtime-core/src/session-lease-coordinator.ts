import type { Database } from "@pi-cloud/database";
import { transitionSandbox, type SandboxState } from "@pi-cloud/domain";
import {
  parseControlToSupervisorMessage,
  createExecutionLease,
  parseExecutionLease,
  parseSupervisorToControlMessage,
  type SupervisorHeartbeatAckMessage,
} from "@pi-cloud/protocol";
import { sql, type Kysely, type Transaction } from "kysely";
import type {
  TurnExecutionLease,
  TurnExecutionAuthority,
  TurnExecutionRequest,
} from "./run-command-executor.ts";

const DEFAULT_LEASE_DURATION_MS = 60_000;

export type SessionLeaseCoordinatorOptions = {
  database: Kysely<Database>;
  sandboxId: string;
  clock?: () => Date;
  idGenerator?: () => string;
  leaseDurationMs?: number;
  heartbeatConnectionId?: string;
  connectionGuard?: SupervisorConnectionGuard;
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
    throw new TypeError("ExecutionLease coordinator clock must return a valid Date");
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

const ACTIVE_SESSION_STATES = new Set(["running", "cancelling"]);
type CurrentAssignmentRequest = Pick<
  TurnExecutionRequest,
  | "tenantId"
  | "projectId"
  | "workspaceId"
  | "sessionId"
  | "runId"
  | "turnId"
  | "attemptId"
  | "commandId"
>;

export class SessionLeaseCoordinator implements TurnExecutionAuthority {
  readonly #database: Kysely<Database>;
  readonly #sandboxId: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #leaseDurationMs: number;
  readonly #heartbeatConnectionId: string;
  readonly #connectionGuard: SupervisorConnectionGuard | undefined;

  constructor(options: SessionLeaseCoordinatorOptions) {
    this.#database = options.database;
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
    if (heartbeat.type !== "supervisor.heartbeat") {
      throw new SessionLeaseCoordinatorError(
        "invalid_heartbeat",
        "ExecutionLease renewal requires a supervisor heartbeat",
        false,
      );
    }
    if (heartbeat.payload.connectionId !== this.#heartbeatConnectionId) {
      throw new SessionLeaseCoordinatorError(
        "stale_connection",
        "Supervisor heartbeat connection is stale",
        false,
      );
    }
    const now = validDate(this.#clock);
    const validUntil = new Date(now.valueOf() + this.#leaseDurationMs);
    const executionLeaseRenewals = await this.#database
      .transaction()
      .execute(async (transaction) => {
        const sandbox = await transaction
          .selectFrom("sandboxes")
          .select([
            "supervisor_id",
            "boot_id",
            "state",
            "max_concurrent_sessions",
            "active_sessions",
          ])
          .where("id", "=", this.#sandboxId)
          .forUpdate()
          .executeTakeFirst();
        if (
          sandbox === undefined ||
          sandbox.supervisor_id !== heartbeat.payload.supervisorId ||
          sandbox.boot_id !== heartbeat.payload.bootId ||
          sandbox.max_concurrent_sessions !== heartbeat.payload.maxConcurrentSessions ||
          (sandbox.state !== "ready" && sandbox.state !== "leased")
        ) {
          throw new SessionLeaseCoordinatorError(
            "stale_supervisor",
            "Supervisor heartbeat identity is stale",
            false,
          );
        }
        const connection = await this.#currentRegisteredConnection(
          transaction,
          {
            supervisorId: heartbeat.payload.supervisorId,
            bootId: heartbeat.payload.bootId,
          },
          now,
          false,
        );
        if (connection !== undefined) {
          await transaction
            .updateTable("supervisor_connections")
            .set({
              accepting_assignments: heartbeat.payload.acceptingAssignments,
              last_heartbeat_at: now,
              expires_at: new Date(now.valueOf() + this.#connectionGuard!.heartbeatTimeoutMs),
            })
            .where("connection_id", "=", this.#heartbeatConnectionId)
            .where("state", "=", "active")
            .executeTakeFirstOrThrow();
        }

        const observations: Array<{
          observation: (typeof heartbeat.payload.sessions)[number];
          identity: ReturnType<typeof parseExecutionLease>;
        }> = [];
        const seenGrantIds = new Set<string>();
        for (const observation of heartbeat.payload.sessions) {
          if (observation.turnId === null || !ACTIVE_SESSION_STATES.has(observation.state)) {
            continue;
          }
          let identity;
          try {
            identity = parseExecutionLease(observation.executionLease);
          } catch {
            continue;
          }
          if (seenGrantIds.has(identity.leaseId)) continue;
          seenGrantIds.add(identity.leaseId);
          observations.push({ observation, identity });
        }

        const grants =
          observations.length === 0
            ? []
            : await transaction
                .selectFrom("session_leases as grant")
                .innerJoin("run_attempts as execution", "execution.id", "grant.attempt_id")
                .select([
                  "grant.lease_id as grantId",
                  "grant.fencing_token as generation",
                  "grant.valid_until as validUntil",
                  "grant.turn_id as turnId",
                  "grant.attempt_id as executionId",
                  "grant.session_id as sessionId",
                  "execution.state as executionState",
                  "execution.lease_id as boundGrantId",
                  "execution.fencing_token as boundGeneration",
                ])
                .where(
                  "grant.lease_id",
                  "in",
                  observations.map(({ identity }) => identity.leaseId),
                )
                .where("grant.sandbox_id", "=", this.#sandboxId)
                .orderBy("grant.lease_id", "asc")
                .forUpdate(["grant", "execution"])
                .execute();
        const grantById = new Map(grants.map((grant) => [grant.grantId, grant]));
        const accepted: Array<{
          observation: (typeof heartbeat.payload.sessions)[number];
          identity: ReturnType<typeof parseExecutionLease>;
          lastAcknowledgedSeq: number;
        }> = [];
        for (const { observation, identity } of observations) {
          const grant = grantById.get(identity.leaseId);
          if (grant === undefined) continue;
          const generation = safeInteger(grant.generation, "ExecutionLease generation");
          if (
            grant.executionId !== identity.attemptId ||
            grant.sessionId !== observation.sessionId ||
            grant.turnId !== observation.turnId ||
            generation !== identity.fencingToken ||
            grant.boundGrantId !== identity.leaseId ||
            safeInteger(grant.boundGeneration ?? -1, "bound ExecutionLease generation") !==
              generation ||
            new Date(grant.validUntil).valueOf() <= now.valueOf() ||
            ["completed", "failed", "cancelled", "timed_out", "superseded"].includes(
              grant.executionState,
            ) ||
            observation.lastAcknowledgedSeq > observation.lastProducedSeq
          ) {
            continue;
          }
          accepted.push({
            observation,
            identity,
            lastAcknowledgedSeq: observation.lastAcknowledgedSeq,
          });
        }
        if (accepted.length > 0) {
          const values = accepted.map(({ observation, identity, lastAcknowledgedSeq }) => ({
            grantId: identity.leaseId,
            executionId: identity.attemptId,
            generation: identity.fencingToken,
            sessionId: observation.sessionId,
            lastAcknowledgedSeq,
          }));
          const renewedGrants = await sql<{ id: string }>`
            with renewal as (
              select * from jsonb_to_recordset(${JSON.stringify(values)}::jsonb) as item(
                "grantId" uuid,
                "executionId" uuid,
                generation bigint,
                "sessionId" uuid,
                "lastAcknowledgedSeq" bigint
              )
            )
            update session_leases as authority
               set valid_until = ${validUntil}, renewed_at = ${now}
              from renewal
             where authority.lease_id = renewal."grantId"
               and authority.attempt_id = renewal."executionId"
               and authority.fencing_token = renewal.generation
               and authority.session_id = renewal."sessionId"
               and authority.valid_until > ${now}
            returning authority.lease_id as id
          `.execute(transaction);
          const renewedAttempts = await sql<{ id: string }>`
            with renewal as (
              select * from jsonb_to_recordset(${JSON.stringify(values)}::jsonb) as item(
                "grantId" uuid,
                "executionId" uuid,
                generation bigint,
                "sessionId" uuid,
                "lastAcknowledgedSeq" bigint
              )
            )
            update run_attempts as execution
               set claim_expires_at = ${validUntil},
                   last_heartbeat_at = ${now},
                   last_event_seq = greatest(execution.last_event_seq, renewal."lastAcknowledgedSeq"),
                   updated_at = ${now}
              from renewal
             where execution.id = renewal."executionId"
               and execution.lease_id = renewal."grantId"
               and execution.fencing_token = renewal.generation
            returning execution.id
          `.execute(transaction);
          if (
            renewedGrants.rows.length !== accepted.length ||
            renewedAttempts.rows.length !== accepted.length
          ) {
            throw new SessionLeaseCoordinatorError(
              "session_lease_invariant",
              "Set-oriented ExecutionLease renewal lost a current execution",
              false,
            );
          }
        }
        const renewals: SupervisorHeartbeatAckMessage["payload"]["executionLeaseRenewals"] =
          accepted.map(({ observation }) => ({
            sessionId: observation.sessionId,
            executionLease: observation.executionLease,
            validUntil: validUntil.toISOString(),
          }));
        await transaction
          .updateTable("sandboxes")
          .set({ updated_at: now })
          .where("id", "=", this.#sandboxId)
          .where("boot_id", "=", heartbeat.payload.bootId)
          .executeTakeFirstOrThrow();
        return renewals;
      });

    const acknowledgement = parseControlToSupervisorMessage({
      protocolVersion: 1,
      messageId: this.#idGenerator(),
      sentAt: now.toISOString(),
      type: "supervisor.heartbeat.ack",
      payload: {
        acknowledgedMessageId: heartbeat.messageId,
        connectionId: this.#heartbeatConnectionId,
        executionLeaseRenewals,
      },
    });
    if (acknowledgement.type !== "supervisor.heartbeat.ack") {
      throw new SessionLeaseCoordinatorError(
        "invalid_heartbeat_ack",
        "ExecutionLease renewal acknowledgement was invalid",
        false,
      );
    }
    return acknowledgement;
  }

  async quarantineSandbox(): Promise<void> {
    const now = validDate(this.#clock);
    await this.#database.transaction().execute(async (transaction) => {
      const sandbox = await transaction
        .selectFrom("sandboxes")
        .select(["state"])
        .where("id", "=", this.#sandboxId)
        .forUpdate()
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

  async acquire(request: TurnExecutionRequest): Promise<TurnExecutionLease> {
    const now = validDate(this.#clock);
    return this.#database.transaction().execute(async (transaction) => {
      const session = await transaction
        .selectFrom("sessions")
        .select(["tenant_id", "project_id", "workspace_id", "state", "last_fencing_token"])
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
          "Session is unavailable for execution",
          false,
        );
      }
      if (session.state !== "cold" && session.state !== "idle") {
        throw new SessionLeaseCoordinatorError(
          "invalid_state",
          "Session is not ready for an execution lease",
          true,
        );
      }
      if (this.#connectionGuard !== undefined) {
        const guardedSandbox = await transaction
          .selectFrom("sandboxes")
          .select(["supervisor_id", "boot_id"])
          .where("id", "=", this.#sandboxId)
          .executeTakeFirst();
        if (guardedSandbox === undefined) {
          throw new SessionLeaseCoordinatorError(
            "sandbox_unavailable",
            "Execution sandbox is unavailable",
            true,
          );
        }
        await this.#currentRegisteredConnection(
          transaction,
          {
            supervisorId: guardedSandbox.supervisor_id,
            bootId: guardedSandbox.boot_id,
          },
          now,
          true,
        );
      }

      const runAttempt = await transaction
        .selectFrom("runs as run")
        .innerJoin("run_attempts as attempt", (join) =>
          join
            .onRef("attempt.run_id", "=", "run.id")
            .onRef("attempt.id", "=", "run.current_attempt_id"),
        )
        .select([
          "run.state as runState",
          "run.current_attempt_id as currentAttemptId",
          "attempt.state as attemptState",
          "attempt.sandbox_id as sandboxId",
          "attempt.lease_id as executionLeaseId",
          "attempt.fencing_token as fencingToken",
        ])
        .where("run.tenant_id", "=", request.tenantId)
        .where("run.id", "=", request.runId)
        .where("run.session_id", "=", request.sessionId)
        .where("run.turn_id", "=", request.turnId)
        .where("run.command_id", "=", request.commandId)
        .where("attempt.id", "=", request.attemptId)
        .forUpdate(["run", "attempt"])
        .executeTakeFirst();
      if (
        runAttempt === undefined ||
        runAttempt.currentAttemptId !== request.attemptId ||
        runAttempt.runState !== "claimed" ||
        runAttempt.attemptState !== "claimed" ||
        runAttempt.sandboxId !== null ||
        runAttempt.executionLeaseId !== null ||
        runAttempt.fencingToken !== null
      ) {
        throw new SessionLeaseCoordinatorError(
          "stale_attempt",
          "Run attempt is unavailable for execution",
          false,
        );
      }

      const existing = await transaction
        .selectFrom("session_leases")
        .selectAll()
        .where("session_id", "=", request.sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (existing !== undefined) {
        if (new Date(existing.valid_until).valueOf() > now.valueOf()) {
          throw new SessionLeaseCoordinatorError(
            "session_lease_conflict",
            "Session already has a current ExecutionLease",
            true,
          );
        }
        await this.#releaseGrantRow(
          transaction,
          existing.session_id,
          existing.lease_id,
          existing.sandbox_id,
          existing.fencing_token,
          now,
        );
      }

      const sandbox = await transaction
        .selectFrom("sandboxes")
        .select([
          "id",
          "supervisor_id",
          "boot_id",
          "state",
          "active_sessions",
          "max_concurrent_sessions",
        ])
        .where("id", "=", this.#sandboxId)
        .forUpdate()
        .executeTakeFirst();
      if (sandbox === undefined || (sandbox.state !== "ready" && sandbox.state !== "leased")) {
        throw new SessionLeaseCoordinatorError(
          "sandbox_unavailable",
          "Execution sandbox is unavailable",
          true,
        );
      }
      if (sandbox.active_sessions >= sandbox.max_concurrent_sessions) {
        throw new SessionLeaseCoordinatorError(
          "capacity",
          "Execution sandbox is at capacity",
          true,
        );
      }
      await this.#currentRegisteredConnection(
        transaction,
        { supervisorId: sandbox.supervisor_id, bootId: sandbox.boot_id },
        now,
        true,
      );

      const previousGeneration = safeInteger(
        session.last_fencing_token,
        "Session execution generation",
      );
      const generation = previousGeneration + 1;
      if (!Number.isSafeInteger(generation)) {
        throw new SessionLeaseCoordinatorError(
          "session_lease_invariant",
          "Session execution generation is exhausted",
          false,
        );
      }
      const grantId = this.#idGenerator();
      const executionLease = createExecutionLease(grantId, request.attemptId, generation);
      const lastEventSeq = safeInteger(request.nextEventSeq, "Run next event sequence") - 1;
      if (lastEventSeq < 0) {
        throw new SessionLeaseCoordinatorError(
          "session_lease_invariant",
          "Run next event sequence must be positive",
          false,
        );
      }
      const validUntil = new Date(now.valueOf() + this.#leaseDurationMs);

      const sessionUpdate = await transaction
        .updateTable("sessions")
        .set({
          last_fencing_token: generation,
          row_version: sql<string>`${sql.ref("row_version")} + 1`,
          updated_at: now,
        })
        .where("id", "=", request.sessionId)
        .where("tenant_id", "=", request.tenantId)
        .where("last_fencing_token", "=", session.last_fencing_token)
        .executeTakeFirst();
      expectOne(sessionUpdate.numUpdatedRows, "advancing a Session execution generation");

      await transaction
        .insertInto("session_leases")
        .values({
          session_id: request.sessionId,
          lease_id: grantId,
          sandbox_id: sandbox.id,
          fencing_token: generation,
          tenant_id: request.tenantId,
          project_id: request.projectId,
          workspace_id: request.workspaceId,
          run_id: request.runId,
          turn_id: request.turnId,
          command_id: request.commandId,
          attempt_id: request.attemptId,
          last_event_seq: lastEventSeq,
          valid_until: validUntil,
          acquired_at: now,
          renewed_at: now,
        })
        .executeTakeFirstOrThrow();

      const nextSandboxState =
        sandbox.state === "ready" ? transitionSandbox(sandbox.state, "leased") : sandbox.state;
      const sandboxUpdate = await transaction
        .updateTable("sandboxes")
        .set({
          state: nextSandboxState,
          active_sessions: sandbox.active_sessions + 1,
          updated_at: now,
        })
        .where("id", "=", sandbox.id)
        .where("state", "=", sandbox.state)
        .where("active_sessions", "=", sandbox.active_sessions)
        .executeTakeFirst();
      expectOne(sandboxUpdate.numUpdatedRows, "reserving sandbox capacity");

      const attemptUpdate = await transaction
        .updateTable("run_attempts")
        .set({
          sandbox_id: sandbox.id,
          lease_id: grantId,
          fencing_token: generation,
          claim_expires_at: validUntil,
          last_heartbeat_at: now,
          updated_at: now,
        })
        .where("tenant_id", "=", request.tenantId)
        .where("run_id", "=", request.runId)
        .where("id", "=", request.attemptId)
        .where("state", "=", "claimed")
        .where("sandbox_id", "is", null)
        .executeTakeFirst();
      expectOne(attemptUpdate.numUpdatedRows, "binding a Run Session lease");

      return { executionLease };
    });
  }

  async assertCurrent(
    transaction: Transaction<Database>,
    request: TurnExecutionRequest,
    acknowledgement: TurnExecutionLease,
    now: Date,
  ): Promise<void> {
    await this.#currentGrant(transaction, request, acknowledgement, now, true);
  }

  async assertCurrentOrExpired(
    transaction: Transaction<Database>,
    request: TurnExecutionRequest,
    acknowledgement: TurnExecutionLease,
    now: Date,
  ): Promise<void> {
    await this.#currentGrant(transaction, request, acknowledgement, now, false);
  }

  async assertCurrentGrant(
    request: TurnExecutionRequest,
    acknowledgement: TurnExecutionLease,
  ): Promise<void> {
    const now = validDate(this.#clock);
    await this.#database.transaction().execute(async (transaction) => {
      await this.#currentGrant(transaction, request, acknowledgement, now, true);
    });
  }

  async currentAssignment(request: CurrentAssignmentRequest): Promise<TurnExecutionLease> {
    const now = validDate(this.#clock);
    return this.#database.transaction().execute(async (transaction) => {
      const session = await transaction
        .selectFrom("sessions")
        .select(["tenant_id", "project_id", "workspace_id", "state", "last_fencing_token"])
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
        .selectFrom("session_leases")
        .selectAll()
        .where("session_id", "=", request.sessionId)
        .forUpdate()
        .executeTakeFirst();
      const generation =
        grant === undefined ? -1 : safeInteger(grant.fencing_token, "ExecutionLease fencing token");
      if (
        grant === undefined ||
        grant.sandbox_id !== this.#sandboxId ||
        grant.tenant_id !== request.tenantId ||
        grant.project_id !== request.projectId ||
        grant.workspace_id !== request.workspaceId ||
        grant.run_id !== request.runId ||
        grant.turn_id !== request.turnId ||
        grant.command_id !== request.commandId ||
        grant.attempt_id !== request.attemptId ||
        new Date(grant.valid_until).valueOf() <= now.valueOf() ||
        generation !== safeInteger(session.last_fencing_token, "Session execution generation")
      ) {
        throw new SessionLeaseCoordinatorError(
          "stale_session_lease",
          "ExecutionLease is stale",
          false,
        );
      }
      return {
        executionLease: createExecutionLease(grant.lease_id, grant.attempt_id, generation),
      };
    });
  }

  async releaseCurrent(
    transaction: Transaction<Database>,
    request: TurnExecutionRequest,
    acknowledgement: TurnExecutionLease,
    now: Date,
  ): Promise<void> {
    const grant = await this.#currentGrant(transaction, request, acknowledgement, now, false);
    const identity = parseExecutionLease(acknowledgement.executionLease);
    await this.#releaseGrantRow(
      transaction,
      request.sessionId,
      identity.leaseId,
      grant.sandbox_id,
      identity.fencingToken,
      now,
    );
  }

  async releaseAcquired(
    request: TurnExecutionRequest,
    acknowledgement: TurnExecutionLease,
  ): Promise<void> {
    const now = validDate(this.#clock);
    await this.#database.transaction().execute(async (transaction) => {
      await this.releaseCurrent(transaction, request, acknowledgement, now);
    });
  }

  async #currentGrant(
    transaction: Transaction<Database>,
    request: TurnExecutionRequest,
    acknowledgement: TurnExecutionLease,
    now: Date,
    requireUnexpired: boolean,
  ) {
    const identity = parseExecutionLease(acknowledgement.executionLease);
    if (identity.attemptId !== request.attemptId) {
      throw new SessionLeaseCoordinatorError(
        "stale_session_lease",
        "ExecutionLease belongs to another Run execution",
        false,
      );
    }
    const grant = await transaction
      .selectFrom("session_leases")
      .selectAll()
      .where("session_id", "=", request.sessionId)
      .where("lease_id", "=", identity.leaseId)
      .where("fencing_token", "=", String(identity.fencingToken))
      .forUpdate()
      .executeTakeFirst();
    if (
      grant === undefined ||
      grant.tenant_id !== request.tenantId ||
      grant.project_id !== request.projectId ||
      grant.workspace_id !== request.workspaceId ||
      grant.run_id !== request.runId ||
      grant.turn_id !== request.turnId ||
      grant.command_id !== request.commandId ||
      grant.attempt_id !== request.attemptId ||
      grant.sandbox_id !== this.#sandboxId ||
      (requireUnexpired && new Date(grant.valid_until).valueOf() <= now.valueOf())
    ) {
      throw new SessionLeaseCoordinatorError(
        "stale_session_lease",
        "ExecutionLease is stale",
        false,
      );
    }
    return grant;
  }

  async #releaseGrantRow(
    transaction: Transaction<Database>,
    sessionId: string,
    grantId: string,
    sandboxId: string,
    generation: string | number | bigint,
    now: Date,
  ): Promise<void> {
    const writer = await transaction
      .selectFrom("session_leases")
      .select(["fact_channel_connection_id", "fact_channel_valid_until"])
      .where("session_id", "=", sessionId)
      .where("lease_id", "=", grantId)
      .where("fencing_token", "=", String(generation))
      .forUpdate()
      .executeTakeFirst();
    if (
      writer?.fact_channel_connection_id !== null &&
      writer?.fact_channel_connection_id !== undefined &&
      writer.fact_channel_valid_until !== null &&
      new Date(writer.fact_channel_valid_until).valueOf() > now.valueOf()
    ) {
      throw new SessionLeaseCoordinatorError(
        "fact_channel_active",
        "ExecutionLease still has an active FactChannel",
        true,
      );
    }
    const sandbox = await transaction
      .selectFrom("sandboxes")
      .select(["state", "active_sessions"])
      .where("id", "=", sandboxId)
      .forUpdate()
      .executeTakeFirst();
    if (
      sandbox === undefined ||
      sandbox.active_sessions < 1 ||
      (sandbox.state !== "leased" && sandbox.state !== "draining" && sandbox.state !== "failed")
    ) {
      throw new SessionLeaseCoordinatorError(
        "session_lease_invariant",
        "ExecutionLease references an unavailable sandbox reservation",
        false,
      );
    }

    const deleted = await transaction
      .deleteFrom("session_leases")
      .where("session_id", "=", sessionId)
      .where("lease_id", "=", grantId)
      .where("sandbox_id", "=", sandboxId)
      .where("fencing_token", "=", String(generation))
      .executeTakeFirst();
    expectOne(deleted.numDeletedRows, "releasing an ExecutionLease");

    const remaining = sandbox.active_sessions - 1;
    let nextState: SandboxState = sandbox.state;
    if (remaining === 0 && sandbox.state === "leased") {
      nextState = transitionSandbox(sandbox.state, "ready");
    }
    const sandboxUpdate = await transaction
      .updateTable("sandboxes")
      .set({ state: nextState, active_sessions: remaining, updated_at: now })
      .where("id", "=", sandboxId)
      .where("state", "=", sandbox.state)
      .where("active_sessions", "=", sandbox.active_sessions)
      .executeTakeFirst();
    expectOne(sandboxUpdate.numUpdatedRows, "releasing sandbox capacity");
  }

  async #currentRegisteredConnection(
    transaction: Transaction<Database>,
    identity: { supervisorId: string; bootId: string },
    now: Date,
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
