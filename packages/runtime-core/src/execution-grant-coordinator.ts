import type { Database } from "@pi-cloud/database";
import { transitionSandbox, type SandboxState } from "@pi-cloud/domain";
import {
  parseControlToSupervisorMessage,
  createExecutionGrant,
  parseExecutionGrant,
  parseSupervisorToControlMessage,
  type SupervisorHeartbeatAckMessage,
} from "@pi-cloud/protocol";
import { sql, type Kysely, type Transaction } from "kysely";
import type {
  TurnExecutionGrant,
  TurnExecutionAuthority,
  TurnExecutionRequest,
} from "./run-command-executor.ts";

const DEFAULT_GRANT_DURATION_MS = 60_000;

export type ExecutionGrantCoordinatorOptions = {
  database: Kysely<Database>;
  sandboxId: string;
  clock?: () => Date;
  idGenerator?: () => string;
  grantDurationMs?: number;
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

export class ExecutionGrantCoordinatorError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "ExecutionGrantCoordinatorError";
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
    throw new TypeError("ExecutionGrant coordinator clock must return a valid Date");
  }
  return value;
}

function safeInteger(value: string | number | bigint, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new ExecutionGrantCoordinatorError(
      "execution_grant_invariant",
      `${name} is outside the supported integer range`,
      false,
    );
  }
  return parsed;
}

function expectOne(updatedRows: bigint, description: string): void {
  if (updatedRows !== 1n) {
    throw new ExecutionGrantCoordinatorError(
      "execution_grant_invariant",
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

const ACTIVE_SESSION_STATES = new Set(["running", "waiting_approval", "cancelling"]);
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

export class ExecutionGrantCoordinator implements TurnExecutionAuthority {
  readonly #database: Kysely<Database>;
  readonly #sandboxId: string;
  readonly #clock: () => Date;
  readonly #idGenerator: () => string;
  readonly #grantDurationMs: number;
  readonly #heartbeatConnectionId: string;
  readonly #connectionGuard: SupervisorConnectionGuard | undefined;

  constructor(options: ExecutionGrantCoordinatorOptions) {
    this.#database = options.database;
    this.#sandboxId = options.sandboxId;
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? (() => globalThis.crypto.randomUUID());
    this.#grantDurationMs = positiveInteger(
      options.grantDurationMs ?? DEFAULT_GRANT_DURATION_MS,
      "grantDurationMs",
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
    return Math.max(1, Math.floor(this.#grantDurationMs / 3));
  }

  async heartbeatIdentity(): Promise<SupervisorHeartbeatIdentity> {
    const sandbox = await this.#database
      .selectFrom("sandboxes")
      .select(["supervisor_id", "boot_id", "state"])
      .where("id", "=", this.#sandboxId)
      .executeTakeFirst();
    if (sandbox === undefined || sandbox.state === "terminated") {
      throw new ExecutionGrantCoordinatorError(
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
      throw new ExecutionGrantCoordinatorError(
        "invalid_heartbeat",
        "ExecutionGrant renewal requires a supervisor heartbeat",
        false,
      );
    }
    if (heartbeat.payload.connectionId !== this.#heartbeatConnectionId) {
      throw new ExecutionGrantCoordinatorError(
        "stale_connection",
        "Supervisor heartbeat connection is stale",
        false,
      );
    }
    const now = validDate(this.#clock);
    const validUntil = new Date(now.valueOf() + this.#grantDurationMs);
    const executionGrantRenewals = await this.#database
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
          throw new ExecutionGrantCoordinatorError(
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

        const renewals: SupervisorHeartbeatAckMessage["payload"]["executionGrantRenewals"] = [];
        for (const observation of heartbeat.payload.sessions) {
          if (observation.turnId === null || !ACTIVE_SESSION_STATES.has(observation.state)) {
            continue;
          }
          let grantIdentity;
          try {
            grantIdentity = parseExecutionGrant(observation.executionGrant);
          } catch {
            continue;
          }
          const grant = await transaction
            .selectFrom("execution_grants as grant")
            .innerJoin("run_attempts as execution", "execution.id", "grant.execution_id")
            .select([
              "grant.grant_id as grantId",
              "grant.generation as generation",
              "grant.valid_until as validUntil",
              "grant.turn_id as turnId",
              "grant.execution_id as executionId",
              "execution.state as executionState",
              "execution.execution_grant_id as boundGrantId",
              "execution.execution_generation as boundGeneration",
            ])
            .where("grant.session_id", "=", observation.sessionId)
            .where("grant.grant_id", "=", grantIdentity.grantId)
            .where("grant.generation", "=", String(grantIdentity.generation))
            .where("grant.sandbox_id", "=", this.#sandboxId)
            .forUpdate(["grant", "execution"])
            .executeTakeFirst();
          if (grant === undefined) continue;
          const generation = safeInteger(grant.generation, "ExecutionGrant generation");
          if (
            grant.executionId !== grantIdentity.executionId ||
            grant.turnId !== observation.turnId ||
            generation !== grantIdentity.generation ||
            grant.boundGrantId !== grantIdentity.grantId ||
            safeInteger(grant.boundGeneration ?? -1, "bound ExecutionGrant generation") !==
              generation ||
            new Date(grant.validUntil).valueOf() <= now.valueOf() ||
            ["completed", "failed", "cancelled", "timed_out", "superseded"].includes(
              grant.executionState,
            ) ||
            observation.lastAcknowledgedSeq > observation.lastProducedSeq
          ) {
            continue;
          }

          const updated = await transaction
            .updateTable("execution_grants")
            .set({ valid_until: validUntil, renewed_at: now })
            .where("session_id", "=", observation.sessionId)
            .where("grant_id", "=", grantIdentity.grantId)
            .where("generation", "=", String(generation))
            .where("valid_until", ">", now)
            .executeTakeFirst();
          if (updated.numUpdatedRows !== 1n) continue;
          const attemptHeartbeat = await transaction
            .updateTable("run_attempts")
            .set({
              claim_expires_at: validUntil,
              last_heartbeat_at: now,
              // JetStream projection may advance the durable event boundary between
              // heartbeat capture and this transaction. A slightly older Worker
              // acknowledgement is valid evidence of liveness, but must never
              // move the canonical boundary backwards.
              last_event_seq: sql<string>`greatest(${sql.ref("last_event_seq")}, ${observation.lastAcknowledgedSeq})`,
              updated_at: now,
            })
            .where("id", "=", grant.executionId)
            .where("execution_grant_id", "=", grantIdentity.grantId)
            .where("execution_generation", "=", String(generation))
            .executeTakeFirst();
          expectOne(attemptHeartbeat.numUpdatedRows, "renewing a run attempt heartbeat");
          renewals.push({
            sessionId: observation.sessionId,
            executionGrant: observation.executionGrant,
            validUntil: validUntil.toISOString(),
          });
        }
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
        executionGrantRenewals,
      },
    });
    if (acknowledgement.type !== "supervisor.heartbeat.ack") {
      throw new ExecutionGrantCoordinatorError(
        "invalid_heartbeat_ack",
        "ExecutionGrant renewal acknowledgement was invalid",
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

  async acquire(request: TurnExecutionRequest): Promise<TurnExecutionGrant> {
    const now = validDate(this.#clock);
    return this.#database.transaction().execute(async (transaction) => {
      const session = await transaction
        .selectFrom("sessions")
        .select(["tenant_id", "project_id", "workspace_id", "state", "last_execution_generation"])
        .where("id", "=", request.sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (
        session === undefined ||
        session.tenant_id !== request.tenantId ||
        session.project_id !== request.projectId ||
        session.workspace_id !== request.workspaceId
      ) {
        throw new ExecutionGrantCoordinatorError(
          "session_unavailable",
          "Session is unavailable for execution",
          false,
        );
      }
      if (session.state !== "cold" && session.state !== "idle") {
        throw new ExecutionGrantCoordinatorError(
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
          throw new ExecutionGrantCoordinatorError(
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
          "attempt.execution_grant_id as executionGrantId",
          "attempt.execution_generation as executionGeneration",
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
        runAttempt.executionGrantId !== null ||
        runAttempt.executionGeneration !== null
      ) {
        throw new ExecutionGrantCoordinatorError(
          "stale_attempt",
          "Run attempt is unavailable for execution",
          false,
        );
      }

      const existing = await transaction
        .selectFrom("execution_grants")
        .selectAll()
        .where("session_id", "=", request.sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (existing !== undefined) {
        if (new Date(existing.valid_until).valueOf() > now.valueOf()) {
          throw new ExecutionGrantCoordinatorError(
            "execution_grant_conflict",
            "Session already has a current ExecutionGrant",
            true,
          );
        }
        await this.#releaseGrantRow(
          transaction,
          existing.session_id,
          existing.grant_id,
          existing.sandbox_id,
          existing.generation,
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
        throw new ExecutionGrantCoordinatorError(
          "sandbox_unavailable",
          "Execution sandbox is unavailable",
          true,
        );
      }
      if (sandbox.active_sessions >= sandbox.max_concurrent_sessions) {
        throw new ExecutionGrantCoordinatorError(
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
        session.last_execution_generation,
        "Session execution generation",
      );
      const generation = previousGeneration + 1;
      if (!Number.isSafeInteger(generation)) {
        throw new ExecutionGrantCoordinatorError(
          "execution_grant_invariant",
          "Session execution generation is exhausted",
          false,
        );
      }
      const grantId = this.#idGenerator();
      const executionGrant = createExecutionGrant(grantId, request.attemptId, generation);
      const lastEventSeq = safeInteger(request.nextEventSeq, "Run next event sequence") - 1;
      if (lastEventSeq < 0) {
        throw new ExecutionGrantCoordinatorError(
          "execution_grant_invariant",
          "Run next event sequence must be positive",
          false,
        );
      }
      const validUntil = new Date(now.valueOf() + this.#grantDurationMs);

      const sessionUpdate = await transaction
        .updateTable("sessions")
        .set({
          last_execution_generation: generation,
          row_version: sql<string>`${sql.ref("row_version")} + 1`,
          updated_at: now,
        })
        .where("id", "=", request.sessionId)
        .where("tenant_id", "=", request.tenantId)
        .where("last_execution_generation", "=", session.last_execution_generation)
        .executeTakeFirst();
      expectOne(sessionUpdate.numUpdatedRows, "advancing a Session execution generation");

      await transaction
        .insertInto("execution_grants")
        .values({
          session_id: request.sessionId,
          grant_id: grantId,
          sandbox_id: sandbox.id,
          generation,
          tenant_id: request.tenantId,
          project_id: request.projectId,
          workspace_id: request.workspaceId,
          run_id: request.runId,
          turn_id: request.turnId,
          command_id: request.commandId,
          execution_id: request.attemptId,
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
          execution_grant_id: grantId,
          execution_generation: generation,
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
      expectOne(attemptUpdate.numUpdatedRows, "binding a Run execution grant");

      return { executionGrant };
    });
  }

  async assertCurrent(
    transaction: Transaction<Database>,
    request: TurnExecutionRequest,
    acknowledgement: TurnExecutionGrant,
    now: Date,
  ): Promise<void> {
    await this.#currentGrant(transaction, request, acknowledgement, now, true);
  }

  async assertCurrentOrExpired(
    transaction: Transaction<Database>,
    request: TurnExecutionRequest,
    acknowledgement: TurnExecutionGrant,
    now: Date,
  ): Promise<void> {
    await this.#currentGrant(transaction, request, acknowledgement, now, false);
  }

  async assertCurrentGrant(
    request: TurnExecutionRequest,
    acknowledgement: TurnExecutionGrant,
  ): Promise<void> {
    const now = validDate(this.#clock);
    await this.#database.transaction().execute(async (transaction) => {
      await this.#currentGrant(transaction, request, acknowledgement, now, true);
    });
  }

  async currentAssignment(request: CurrentAssignmentRequest): Promise<TurnExecutionGrant> {
    const now = validDate(this.#clock);
    return this.#database.transaction().execute(async (transaction) => {
      const session = await transaction
        .selectFrom("sessions")
        .select(["tenant_id", "project_id", "workspace_id", "state", "last_execution_generation"])
        .where("id", "=", request.sessionId)
        .forUpdate()
        .executeTakeFirst();
      if (
        session === undefined ||
        session.tenant_id !== request.tenantId ||
        session.project_id !== request.projectId ||
        session.workspace_id !== request.workspaceId
      ) {
        throw new ExecutionGrantCoordinatorError(
          "session_unavailable",
          "Session is unavailable for cancellation",
          false,
        );
      }
      if (session.state !== "running" && session.state !== "waiting_approval") {
        throw new ExecutionGrantCoordinatorError(
          "invalid_state",
          "Session no longer has an active execution to cancel",
          false,
        );
      }

      const grant = await transaction
        .selectFrom("execution_grants")
        .selectAll()
        .where("session_id", "=", request.sessionId)
        .forUpdate()
        .executeTakeFirst();
      const generation =
        grant === undefined ? -1 : safeInteger(grant.generation, "ExecutionGrant generation");
      if (
        grant === undefined ||
        grant.sandbox_id !== this.#sandboxId ||
        grant.tenant_id !== request.tenantId ||
        grant.project_id !== request.projectId ||
        grant.workspace_id !== request.workspaceId ||
        grant.run_id !== request.runId ||
        grant.turn_id !== request.turnId ||
        grant.command_id !== request.commandId ||
        grant.execution_id !== request.attemptId ||
        new Date(grant.valid_until).valueOf() <= now.valueOf() ||
        generation !==
          safeInteger(session.last_execution_generation, "Session execution generation")
      ) {
        throw new ExecutionGrantCoordinatorError(
          "stale_execution_grant",
          "ExecutionGrant is stale",
          false,
        );
      }
      return {
        executionGrant: createExecutionGrant(grant.grant_id, grant.execution_id, generation),
      };
    });
  }

  async releaseCurrent(
    transaction: Transaction<Database>,
    request: TurnExecutionRequest,
    acknowledgement: TurnExecutionGrant,
    now: Date,
  ): Promise<void> {
    const grant = await this.#currentGrant(transaction, request, acknowledgement, now, false);
    const identity = parseExecutionGrant(acknowledgement.executionGrant);
    await this.#releaseGrantRow(
      transaction,
      request.sessionId,
      identity.grantId,
      grant.sandbox_id,
      identity.generation,
      now,
    );
  }

  async releaseAcquired(
    request: TurnExecutionRequest,
    acknowledgement: TurnExecutionGrant,
  ): Promise<void> {
    const now = validDate(this.#clock);
    await this.#database.transaction().execute(async (transaction) => {
      await this.releaseCurrent(transaction, request, acknowledgement, now);
    });
  }

  async #currentGrant(
    transaction: Transaction<Database>,
    request: TurnExecutionRequest,
    acknowledgement: TurnExecutionGrant,
    now: Date,
    requireUnexpired: boolean,
  ) {
    const identity = parseExecutionGrant(acknowledgement.executionGrant);
    if (identity.executionId !== request.attemptId) {
      throw new ExecutionGrantCoordinatorError(
        "stale_execution_grant",
        "ExecutionGrant belongs to another Run execution",
        false,
      );
    }
    const grant = await transaction
      .selectFrom("execution_grants")
      .selectAll()
      .where("session_id", "=", request.sessionId)
      .where("grant_id", "=", identity.grantId)
      .where("generation", "=", String(identity.generation))
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
      grant.execution_id !== request.attemptId ||
      grant.sandbox_id !== this.#sandboxId ||
      (requireUnexpired && new Date(grant.valid_until).valueOf() <= now.valueOf())
    ) {
      throw new ExecutionGrantCoordinatorError(
        "stale_execution_grant",
        "ExecutionGrant is stale",
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
      throw new ExecutionGrantCoordinatorError(
        "execution_grant_invariant",
        "ExecutionGrant references an unavailable sandbox reservation",
        false,
      );
    }

    const deleted = await transaction
      .deleteFrom("execution_grants")
      .where("session_id", "=", sessionId)
      .where("grant_id", "=", grantId)
      .where("sandbox_id", "=", sandboxId)
      .where("generation", "=", String(generation))
      .executeTakeFirst();
    expectOne(deleted.numDeletedRows, "releasing an ExecutionGrant");

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
      throw new ExecutionGrantCoordinatorError(
        "stale_connection",
        "Supervisor connection is stale",
        false,
      );
    }
    if (requireAcceptingAssignments && !connection.accepting_assignments) {
      throw new ExecutionGrantCoordinatorError(
        "connection_not_accepting",
        "Supervisor connection is not accepting assignments",
        true,
      );
    }
    return { acceptingAssignments: connection.accepting_assignments };
  }
}
