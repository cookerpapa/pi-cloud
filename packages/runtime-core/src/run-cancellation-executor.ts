import type { Database } from "@pi-cloud/database";
import {
  transitionTurnControlRequest,
  transitionSession,
  transitionTurn,
  type TurnControlRequestState,
  type SessionState,
  type TurnState,
} from "@pi-cloud/domain";
import {
  parseCloudToolCapabilitySnapshot,
  parseEnvironmentRuntimeSnapshot,
  type CancelTurnCommandMessage,
} from "@pi-cloud/protocol";
import { sql, type Kysely, type Transaction } from "kysely";
import { randomUUID } from "node:crypto";
import type {
  TurnExecutionAuthority,
  TurnExecutionLease,
  TurnExecutionRequest,
} from "./run-executor.ts";
import { transitionCurrentRunAttempt } from "./run-attempt-state.ts";
import { commitTerminalTurnEvent } from "./terminal-turn-event.ts";
import type {
  PreparedTerminalTurnProjection,
  TerminalTurnProjectionSource,
} from "./terminal-turn-projection.ts";

const DEFAULT_CLAIM_LEASE_MS = 30_000;
const DEFAULT_RETRY_DELAY_MS = 1_000;
const DEFAULT_MAX_ATTEMPTS = 3;

export type TurnCancellationReason = CancelTurnCommandMessage["payload"]["reason"];

export type TurnCancellationRequest = {
  controlRequestId: string;
  idempotencyKey: string;
  reason: TurnCancellationReason;
  gracePeriodMs: number;
  target: TurnExecutionRequest;
};

export type TurnCancellationLifecycle = {
  started(grant: TurnExecutionLease): Promise<void>;
};

export type TurnCancellationResult = {
  reason: TurnCancellationReason;
  forced: boolean;
  lastEventSeq?: number;
};

export interface TurnCancellationBackend {
  cancel(
    request: TurnCancellationRequest,
    lifecycle: TurnCancellationLifecycle,
  ): Promise<TurnCancellationResult>;
}

export class TurnCancellationBackendError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "TurnCancellationBackendError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class RunCancellationExecutorInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunCancellationExecutorInvariantError";
  }
}

export class RunCancellationExecutorStaleClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunCancellationExecutorStaleClaimError";
  }
}

export type RunCancellationExecutionResult =
  | { status: "idle" }
  | {
      status: "cancelled";
      controlRequestId: string;
      targetRunId: string;
      sessionId: string;
      turnId: string;
      attempt: number;
      forced: boolean;
    }
  | {
      status: "retry_scheduled";
      controlRequestId: string;
      targetRunId: string;
      sessionId: string;
      turnId: string;
      attempt: number;
      failureCode: string;
    }
  | {
      status: "failed";
      controlRequestId: string;
      targetRunId: string;
      sessionId: string;
      turnId: string;
      attempt: number;
      phase: "before_start" | "after_start";
      failureCode: string;
    };

export type RunCancellationExecutorOptions = {
  database: Kysely<Database>;
  backend: TurnCancellationBackend;
  executionAuthority: TurnExecutionAuthority;
  clock?: () => Date;
  claimLeaseMs?: number;
  retryDelayMs?: number;
  maxAttempts?: number;
  idGenerator?: () => string;
  terminalTurnProjectionSource?: TerminalTurnProjectionSource;
};

type ClaimedCancellation = {
  attempt: number;
  request: TurnCancellationRequest;
};

type CancellationLifecycleRows = {
  cancellationTurnControlRequestState: TurnControlRequestState;
  turnState: TurnState;
  sessionState: SessionState;
  controlAttempts: number;
  runState: import("@pi-cloud/domain").RunState;
  runAttemptState: import("@pi-cloud/domain").RunAttemptState;
  currentAttemptId: string | null;
};

type CancellationFailure = {
  code: string;
  safeMessage: string;
  retryable: boolean;
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function safeDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("cancellation dispatcher clock must return a valid Date");
  }
  return value;
}

function parseCancellationPayload(value: Record<string, unknown>): {
  reason: TurnCancellationReason;
  gracePeriodMs: number;
} {
  const reason = value.reason;
  const gracePeriodMs = value.gracePeriodMs;
  if (
    reason !== "user_request" &&
    reason !== "timeout" &&
    reason !== "session_lease_revoked" &&
    reason !== "shutdown"
  ) {
    throw new RunCancellationExecutorInvariantError("Cancellation command reason is invalid");
  }
  if (!Number.isSafeInteger(gracePeriodMs) || (gracePeriodMs as number) < 0) {
    throw new RunCancellationExecutorInvariantError("Cancellation grace period is invalid");
  }
  return { reason, gracePeriodMs: gracePeriodMs as number };
}

function normalizeFailure(error: unknown): CancellationFailure {
  if (error instanceof TurnCancellationBackendError) {
    return { code: error.code, safeMessage: error.message, retryable: error.retryable };
  }
  return {
    code: "cancellation_backend_error",
    safeMessage: "Cancellation backend failed",
    retryable: true,
  };
}

function expectOne(changedRows: bigint, description: string): void {
  if (changedRows !== 1n) {
    throw new RunCancellationExecutorInvariantError(`${description} changed ${changedRows} rows`);
  }
}

export class RunCancellationExecutor {
  readonly #database: Kysely<Database>;
  readonly #backend: TurnCancellationBackend;
  readonly #executionAuthority: TurnExecutionAuthority;
  readonly #clock: () => Date;
  readonly #claimLeaseMs: number;
  readonly #retryDelayMs: number;
  readonly #maxAttempts: number;
  readonly #idGenerator: () => string;
  readonly #terminalTurnProjectionSource: TerminalTurnProjectionSource | undefined;

  constructor(options: RunCancellationExecutorOptions) {
    this.#database = options.database;
    this.#backend = options.backend;
    this.#executionAuthority = options.executionAuthority;
    this.#clock = options.clock ?? (() => new Date());
    this.#claimLeaseMs = positiveInteger(
      options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS,
      "claimLeaseMs",
    );
    this.#retryDelayMs = positiveInteger(
      options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS,
      "retryDelayMs",
    );
    this.#maxAttempts = positiveInteger(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, "maxAttempts");
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#terminalTurnProjectionSource = options.terminalTurnProjectionSource;
  }

  /**
   * Executes the cancellation for one exact execution command. The queue routes
   * it only to the Worker that owns the live Pi runtime.
   */
  async dispatchTargetRun(targetRunId: string): Promise<RunCancellationExecutionResult> {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        targetRunId,
      )
    ) {
      throw new TypeError("targetRunId must be a UUID");
    }
    return this.#dispatch(targetRunId.toLowerCase());
  }

  async #dispatch(targetRunId: string): Promise<RunCancellationExecutionResult> {
    const claim = await this.#claimNext(targetRunId);
    if (claim === undefined) return { status: "idle" };

    let started = false;
    let acknowledgement: TurnExecutionLease | undefined;
    let startedPromise: Promise<void> | undefined;
    let startFailure: unknown;
    const lifecycle: TurnCancellationLifecycle = {
      started: (candidate) => {
        if (
          startedPromise !== undefined &&
          candidate.executionLease !== acknowledgement?.executionLease
        ) {
          return Promise.reject(
            new RunCancellationExecutorInvariantError(
              "Cancellation acknowledgement changed after start",
            ),
          );
        }
        acknowledgement = candidate;
        startedPromise ??= this.#markStarted(claim, candidate).then(
          () => {
            started = true;
          },
          (error: unknown) => {
            startFailure = error;
            throw error;
          },
        );
        return startedPromise;
      },
    };

    let result: TurnCancellationResult;
    try {
      result = await this.#backend.cancel(claim.request, lifecycle);
      if (startedPromise !== undefined) await startedPromise;
      if (!started || acknowledgement === undefined) {
        throw new TurnCancellationBackendError(
          "backend_protocol_violation",
          "Cancellation backend returned before acknowledging the command",
          false,
        );
      }
      if (result.reason !== claim.request.reason || typeof result.forced !== "boolean") {
        throw new TurnCancellationBackendError(
          "backend_protocol_violation",
          "Cancellation backend returned an invalid termination confirmation",
          false,
        );
      }
    } catch (error: unknown) {
      if (startedPromise !== undefined && !started && startFailure === undefined) {
        try {
          await startedPromise;
        } catch {
          // Preserve the durable lifecycle failure below.
        }
      }
      if (startFailure !== undefined) {
        if (startFailure instanceof TurnCancellationBackendError) {
          return this.#recordFailure(claim, false, normalizeFailure(startFailure));
        }
        throw startFailure;
      }
      return this.#recordFailure(claim, started, normalizeFailure(error));
    }

    await this.#complete(claim, acknowledgement, result);
    return {
      status: "cancelled",
      controlRequestId: claim.request.controlRequestId,
      targetRunId: claim.request.target.runId,
      sessionId: claim.request.target.sessionId,
      turnId: claim.request.target.turnId,
      attempt: claim.attempt,
      forced: result.forced,
    };
  }

  async #claimNext(targetRunId: string): Promise<ClaimedCancellation | undefined> {
    const now = safeDate(this.#clock);
    const leaseUntil = new Date(now.valueOf() + this.#claimLeaseMs);
    return this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom("turn_control_requests as cancellation")
        .innerJoin("turns as turn", (join) =>
          join
            .onRef("turn.tenant_id", "=", "cancellation.tenant_id")
            .onRef("turn.session_id", "=", "cancellation.session_id")
            .onRef("turn.id", "=", "cancellation.turn_id"),
        )
        .innerJoin("sessions as session_row", (join) =>
          join
            .onRef("session_row.tenant_id", "=", "cancellation.tenant_id")
            .onRef("session_row.id", "=", "cancellation.session_id"),
        )
        .innerJoin("runs as run", (join) =>
          join
            .onRef("run.tenant_id", "=", "cancellation.tenant_id")
            .onRef("run.session_id", "=", "cancellation.session_id")
            .onRef("run.turn_id", "=", "cancellation.turn_id")
            .onRef("run.id", "=", "cancellation.target_run_id"),
        )
        .innerJoin(
          "agent_revisions as agent_revision",
          "agent_revision.id",
          "run.agent_revision_id",
        )
        .innerJoin(
          "agent_definitions as agent_definition",
          "agent_definition.id",
          "agent_revision.definition_id",
        )
        .innerJoin("run_attempts as run_attempt", (join) =>
          join
            .onRef("run_attempt.run_id", "=", "run.id")
            .onRef("run_attempt.id", "=", "run.current_attempt_id"),
        )
        .innerJoin("environment_versions as environment", (join) =>
          join
            .onRef("environment.tenant_id", "=", "run.tenant_id")
            .onRef("environment.project_id", "=", "run.project_id")
            .onRef("environment.id", "=", "run.environment_version_id"),
        )
        .select([
          "cancellation.tenant_id as tenantId",
          "cancellation.id as controlRequestId",
          "cancellation.idempotency_key as cancellationIdempotencyKey",
          "cancellation.payload as cancellationPayload",
          "cancellation.state as cancellationTurnControlRequestState",
          "cancellation.attempts as attempts",
          "run.idempotency_key as targetIdempotencyKey",
          "run.agent_revision_id as agentRevisionId",
          "agent_definition.key as agentDefinitionKey",
          "agent_revision.runtime_kind as agentRuntimeKind",
          "agent_revision.runtime_version as agentRuntimeVersion",
          "agent_revision.harness_version as agentHarnessVersion",
          "agent_revision.session_storage_kind as agentSessionStorageKind",
          "turn.id as turnId",
          "turn.input_kind as inputKind",
          "turn.input_text as inputText",
          "turn.model_profile_id as modelProfileId",
          "turn.provider as provider",
          "turn.model_id as modelId",
          "turn.thinking_level as thinkingLevel",
          "turn.service_tier as serviceTier",
          "turn.credential_binding_id as credentialBindingId",
          "turn.credential_binding_version as credentialBindingVersion",
          "session_row.id as sessionId",
          "session_row.pi_session_id as piSessionId",
          "session_row.pi_session_lane as piSessionLane",
          "session_row.project_id as projectId",
          "session_row.workspace_id as workspaceId",
          "session_row.execution_mode as executionMode",
          "session_row.next_event_seq as nextEventSeq",
          "run.id as runId",
          "run.sandbox_profile_key as sandboxProfileKey",
          "run.working_directory as workingDirectory",
          "run.tool_capability_snapshot as toolCapabilitySnapshot",
          "run_attempt.id as runAttemptId",
          "run_attempt.attempt_number as runAttemptNumber",
          "environment.id as environmentVersionId",
          "environment.version_number as environmentVersionNumber",
          "environment.profile_key as environmentProfileKey",
          "environment.profile_version as environmentProfileVersion",
          "environment.image_revision as environmentImageRevision",
          "environment.spec_sha256 as environmentSpecSha256",
          "environment.recipe as environmentRecipe",
          "environment.recipe_sha256 as environmentRecipeSha256",
        ])
        .where("cancellation.available_at", "<=", now)
        .where("cancellation.kind", "=", "cancel")
        .where("cancellation.state", "in", ["pending", "dispatched"])
        .where("run.id", "=", targetRunId)
        .orderBy("cancellation.available_at", "asc")
        .orderBy("cancellation.created_at", "asc")
        .orderBy("cancellation.id", "asc")
        .limit(1)
        .forUpdate(["cancellation", "turn", "session_row", "run", "run_attempt"])
        .skipLocked()
        .executeTakeFirst();
      if (row === undefined) return undefined;

      const commandPayload = parseCancellationPayload(row.cancellationPayload);
      if (row.inputKind !== "prompt" || row.inputText === null) {
        throw new RunCancellationExecutorInvariantError(
          "The v1 cancellation dispatcher only targets durable prompt turns",
        );
      }

      if (row.cancellationTurnControlRequestState === "pending") {
        const commandUpdate = await transaction
          .updateTable("turn_control_requests")
          .set({
            state: transitionTurnControlRequest(
              row.cancellationTurnControlRequestState,
              "dispatched",
            ),
            dispatched_at: now,
            failure_code: null,
          })
          .where("tenant_id", "=", row.tenantId)
          .where("id", "=", row.controlRequestId)
          .where("state", "=", row.cancellationTurnControlRequestState)
          .executeTakeFirst();
        expectOne(commandUpdate.numUpdatedRows, "claiming a cancellation command");
      }

      const outboxUpdate = await transaction
        .updateTable("turn_control_requests")
        .set({
          attempts: sql<number>`${sql.ref("attempts")} + 1`,
          available_at: leaseUntil,
          failure_code: null,
        })
        .where("tenant_id", "=", row.tenantId)
        .where("id", "=", row.controlRequestId)
        .where("state", "=", "dispatched")
        .executeTakeFirst();
      expectOne(outboxUpdate.numUpdatedRows, "leasing a cancellation request");

      return {
        attempt: row.attempts + 1,
        request: {
          controlRequestId: row.controlRequestId,
          idempotencyKey: row.cancellationIdempotencyKey,
          reason: commandPayload.reason,
          gracePeriodMs: commandPayload.gracePeriodMs,
          target: {
            tenantId: row.tenantId,
            projectId: row.projectId,
            workspaceId: row.workspaceId,
            sessionId: row.sessionId,
            piSessionId: row.piSessionId,
            piSessionLane: row.piSessionLane,
            runId: row.runId,
            turnId: row.turnId,
            attemptId: row.runAttemptId,
            attemptNumber: row.runAttemptNumber,
            agent: {
              revisionId: row.agentRevisionId,
              definitionKey: row.agentDefinitionKey,
              runtimeKind: row.agentRuntimeKind,
              runtimeVersion: row.agentRuntimeVersion,
              harnessVersion: row.agentHarnessVersion,
              sessionStorageKind: row.agentSessionStorageKind,
            },
            idempotencyKey: row.targetIdempotencyKey,
            nextEventSeq: row.nextEventSeq,
            input: { kind: "prompt", prompt: row.inputText },
            executionMode: row.executionMode,
            sandboxProfileKey: row.sandboxProfileKey,
            workingDirectory: row.workingDirectory,
            toolCapabilities: parseCloudToolCapabilitySnapshot(row.toolCapabilitySnapshot),
            model: {
              profileId: row.modelProfileId,
              provider: row.provider,
              modelId: row.modelId,
              thinkingLevel: row.thinkingLevel,
              serviceTier: row.serviceTier,
              credentialBindingId: row.credentialBindingId,
              credentialBindingVersion: row.credentialBindingVersion,
            },
            environment: parseEnvironmentRuntimeSnapshot({
              environmentVersionId: row.environmentVersionId,
              versionNumber: row.environmentVersionNumber,
              profileKey: row.environmentProfileKey,
              profileVersion: row.environmentProfileVersion,
              imageRevision: row.environmentImageRevision,
              specSha256: row.environmentSpecSha256,
              recipe: row.environmentRecipe,
              recipeSha256: row.environmentRecipeSha256,
            }),
          },
        },
      };
    });
  }

  async #markStarted(
    claim: ClaimedCancellation,
    acknowledgement: TurnExecutionLease,
  ): Promise<void> {
    const now = safeDate(this.#clock);
    await this.#database.transaction().execute(async (transaction) => {
      const rows = await this.#lockLifecycleRows(transaction, claim);
      const activePair = rows.turnState === "running" && rows.sessionState === "running";
      if (
        rows.cancellationTurnControlRequestState !== "dispatched" ||
        !["provisioning", "restoring", "running", "settling"].includes(rows.runState) ||
        !activePair
      ) {
        throw new TurnCancellationBackendError(
          "cancellation_too_late",
          "Turn was no longer active when cancellation reached the supervisor",
          false,
        );
      }
      const canonicalTerminalEvent = await transaction
        .selectFrom("session_terminal_events")
        .select("event_id")
        .where("tenant_id", "=", claim.request.target.tenantId)
        .where("session_id", "=", claim.request.target.sessionId)
        .where("turn_id", "=", claim.request.target.turnId)
        .where("run_id", "=", claim.request.target.runId)
        .executeTakeFirst();
      if (canonicalTerminalEvent !== undefined) {
        throw new TurnCancellationBackendError(
          "cancellation_too_late",
          "Turn already emitted a terminal event before cancellation",
          false,
        );
      }
      await this.#executionAuthority.assertCurrent(
        transaction,
        claim.request.target,
        acknowledgement,
        now,
      );
      await transitionCurrentRunAttempt(
        transaction,
        {
          tenantId: claim.request.target.tenantId,
          runId: claim.request.target.runId,
          attemptId: claim.request.target.attemptId,
        },
        {
          runState: "cancel_requested",
          attemptState: "cancel_requested",
          reason: `cancellation_${claim.request.reason}`,
          now,
          heartbeat: true,
        },
      );

      const cancellationUpdate = await transaction
        .updateTable("turn_control_requests")
        .set({
          state: transitionTurnControlRequest(
            rows.cancellationTurnControlRequestState,
            "acknowledged",
          ),
          acknowledged_at: now,
        })
        .where("tenant_id", "=", claim.request.target.tenantId)
        .where("id", "=", claim.request.controlRequestId)
        .where("state", "=", rows.cancellationTurnControlRequestState)
        .executeTakeFirst();
      expectOne(cancellationUpdate.numUpdatedRows, "acknowledging a cancellation command");

      const turnUpdate = await transaction
        .updateTable("turns")
        .set({ state: transitionTurn(rows.turnState, "cancelling") })
        .where("tenant_id", "=", claim.request.target.tenantId)
        .where("id", "=", claim.request.target.turnId)
        .where("state", "=", rows.turnState)
        .executeTakeFirst();
      expectOne(turnUpdate.numUpdatedRows, "cancelling a turn");

      const sessionUpdate = await transaction
        .updateTable("sessions")
        .set({
          state: transitionSession(rows.sessionState, "cancelling"),
          row_version: sql<string>`${sql.ref("row_version")} + 1`,
          updated_at: now,
          last_active_at: now,
        })
        .where("tenant_id", "=", claim.request.target.tenantId)
        .where("id", "=", claim.request.target.sessionId)
        .where("state", "=", rows.sessionState)
        .executeTakeFirst();
      expectOne(sessionUpdate.numUpdatedRows, "cancelling a session");
    });
  }

  async #complete(
    claim: ClaimedCancellation,
    acknowledgement: TurnExecutionLease,
    result: TurnCancellationResult,
  ): Promise<void> {
    const now = safeDate(this.#clock);
    const terminalEventId = this.#idGenerator();
    const terminalBody = {
      type: "turn.cancelled",
      payload: { reason: result.reason, forced: result.forced },
    } as const;
    let preparedProjection: PreparedTerminalTurnProjection | undefined;
    const initialEventSeq = Number(claim.request.target.nextEventSeq) - 1;
    const hasVisibleTurnPrefix =
      result.lastEventSeq !== undefined && result.lastEventSeq > initialEventSeq;
    if (hasVisibleTurnPrefix) {
      try {
        preparedProjection = await this.#terminalTurnProjectionSource?.prepare({
          tenantId: claim.request.target.tenantId,
          sessionId: claim.request.target.sessionId,
          turnId: claim.request.target.turnId,
          runId: claim.request.target.runId,
          agentId: "root",
          body: terminalBody,
          eventId: terminalEventId,
          occurredAt: now.toISOString(),
        });
      } catch {
        // Stream-prefix recovery is best effort for cancellation.
      }
    }
    await this.#database.transaction().execute(async (transaction) => {
      const rows = await this.#lockLifecycleRows(transaction, claim);
      if (
        rows.cancellationTurnControlRequestState !== "acknowledged" ||
        rows.turnState !== "cancelling" ||
        rows.sessionState !== "cancelling" ||
        rows.runState !== "cancel_requested"
      ) {
        throw new RunCancellationExecutorInvariantError(
          "Only an acknowledged cancellation can settle a turn",
        );
      }

      await this.#executionAuthority.assertCurrent(
        transaction,
        claim.request.target,
        acknowledgement,
        now,
      );
      if (result.lastEventSeq !== undefined) {
        const boundary = await transaction
          .updateTable("run_attempts")
          .set({ last_event_seq: result.lastEventSeq, updated_at: now })
          .where("tenant_id", "=", claim.request.target.tenantId)
          .where("run_id", "=", claim.request.target.runId)
          .where("id", "=", claim.request.target.attemptId)
          .where("last_event_seq", "<=", String(result.lastEventSeq))
          .executeTakeFirst();
        if (boundary.numUpdatedRows !== 1n) {
          const existing = await transaction
            .selectFrom("run_attempts")
            .select("last_event_seq")
            .where("tenant_id", "=", claim.request.target.tenantId)
            .where("run_id", "=", claim.request.target.runId)
            .where("id", "=", claim.request.target.attemptId)
            .executeTakeFirst();
          if (existing === undefined || Number(existing.last_event_seq) < result.lastEventSeq) {
            throw new RunCancellationExecutorInvariantError(
              "Cancelled Run event boundary could not be advanced or confirmed",
            );
          }
        }
      }
      await transitionCurrentRunAttempt(
        transaction,
        {
          tenantId: claim.request.target.tenantId,
          runId: claim.request.target.runId,
          attemptId: claim.request.target.attemptId,
        },
        {
          runState: "cancelled",
          attemptState: "cancelled",
          reason: "cancellation_confirmed",
          now,
          stopReason: "cancelled",
        },
      );

      const cancellationUpdate = await transaction
        .updateTable("turn_control_requests")
        .set({
          state: transitionTurnControlRequest(
            rows.cancellationTurnControlRequestState,
            "completed",
          ),
          completed_at: now,
          failure_code: null,
        })
        .where("tenant_id", "=", claim.request.target.tenantId)
        .where("id", "=", claim.request.controlRequestId)
        .where("state", "=", rows.cancellationTurnControlRequestState)
        .executeTakeFirst();
      expectOne(cancellationUpdate.numUpdatedRows, "completing a cancellation command");

      const turnUpdate = await transaction
        .updateTable("turns")
        .set({
          state: transitionTurn(rows.turnState, "cancelled"),
          stop_reason: "cancelled",
          settled_at: now,
        })
        .where("tenant_id", "=", claim.request.target.tenantId)
        .where("id", "=", claim.request.target.turnId)
        .where("state", "=", rows.turnState)
        .executeTakeFirst();
      expectOne(turnUpdate.numUpdatedRows, "settling a cancelled turn");

      const sessionUpdate = await transaction
        .updateTable("sessions")
        .set({
          state: transitionSession(rows.sessionState, "idle"),
          row_version: sql<string>`${sql.ref("row_version")} + 1`,
          updated_at: now,
          last_active_at: now,
        })
        .where("tenant_id", "=", claim.request.target.tenantId)
        .where("id", "=", claim.request.target.sessionId)
        .where("state", "=", rows.sessionState)
        .executeTakeFirst();
      expectOne(sessionUpdate.numUpdatedRows, "settling a cancelled session");
      await commitTerminalTurnEvent(transaction, {
        tenantId: claim.request.target.tenantId,
        sessionId: claim.request.target.sessionId,
        turnId: claim.request.target.turnId,
        runId: claim.request.target.runId,
        agentId: "root",
        body: terminalBody,
        now,
        eventId: terminalEventId,
        ...(preparedProjection === undefined ? {} : { preparedProjection }),
      });

      await this.#executionAuthority.releaseCurrent(
        transaction,
        claim.request.target,
        acknowledgement,
        now,
      );
    });
  }

  async #recordFailure(
    claim: ClaimedCancellation,
    started: boolean,
    failure: CancellationFailure,
  ): Promise<RunCancellationExecutionResult> {
    const now = safeDate(this.#clock);
    const shouldRetry = !started && failure.retryable && claim.attempt < this.#maxAttempts;

    await this.#database.transaction().execute(async (transaction) => {
      const rows = await this.#lockLifecycleRows(transaction, claim);
      if (shouldRetry) {
        if (rows.cancellationTurnControlRequestState !== "dispatched") {
          throw new RunCancellationExecutorInvariantError(
            "Only an unacknowledged cancellation can return to the mailbox",
          );
        }
        const requestUpdate = await transaction
          .updateTable("turn_control_requests")
          .set({
            state: transitionTurnControlRequest(
              rows.cancellationTurnControlRequestState,
              "pending",
            ),
            available_at: new Date(now.valueOf() + this.#retryDelayMs),
            failure_code: failure.code,
          })
          .where("tenant_id", "=", claim.request.target.tenantId)
          .where("id", "=", claim.request.controlRequestId)
          .where("state", "=", rows.cancellationTurnControlRequestState)
          .executeTakeFirst();
        expectOne(requestUpdate.numUpdatedRows, "requeueing a cancellation request");
        return;
      }

      const expectedCancellationState = started ? "acknowledged" : "dispatched";
      if (rows.cancellationTurnControlRequestState !== expectedCancellationState) {
        throw new RunCancellationExecutorInvariantError(
          "Cancellation lifecycle does not match the reported failure phase",
        );
      }

      const cancellationUpdate = await transaction
        .updateTable("turn_control_requests")
        .set({
          state: transitionTurnControlRequest(rows.cancellationTurnControlRequestState, "failed"),
          completed_at: now,
          failure_code: failure.code,
        })
        .where("tenant_id", "=", claim.request.target.tenantId)
        .where("id", "=", claim.request.controlRequestId)
        .where("state", "=", rows.cancellationTurnControlRequestState)
        .executeTakeFirst();
      expectOne(cancellationUpdate.numUpdatedRows, "failing a cancellation request");

      if (started) {
        if (
          rows.runState !== "cancel_requested" ||
          rows.turnState !== "cancelling" ||
          rows.sessionState !== "cancelling"
        ) {
          throw new RunCancellationExecutorInvariantError(
            "A started cancellation must own the cancelling lifecycle",
          );
        }
        await transitionCurrentRunAttempt(
          transaction,
          {
            tenantId: claim.request.target.tenantId,
            runId: claim.request.target.runId,
            attemptId: claim.request.target.attemptId,
          },
          {
            runState: "failed",
            attemptState: "failed",
            reason: "cancellation_failed",
            now,
            failure: {
              code: failure.code,
              message: failure.safeMessage,
              retryable: false,
            },
          },
        );
        const turnUpdate = await transaction
          .updateTable("turns")
          .set({
            state: transitionTurn(rows.turnState, "failed"),
            failure_code: failure.code,
            failure_message: failure.safeMessage,
            failure_retryable: false,
            settled_at: now,
          })
          .where("tenant_id", "=", claim.request.target.tenantId)
          .where("id", "=", claim.request.target.turnId)
          .where("state", "=", rows.turnState)
          .executeTakeFirst();
        expectOne(turnUpdate.numUpdatedRows, "failing a cancelling turn");

        const sessionUpdate = await transaction
          .updateTable("sessions")
          .set({
            state: transitionSession(rows.sessionState, "failed"),
            row_version: sql<string>`${sql.ref("row_version")} + 1`,
            updated_at: now,
            last_active_at: now,
          })
          .where("tenant_id", "=", claim.request.target.tenantId)
          .where("id", "=", claim.request.target.sessionId)
          .where("state", "=", rows.sessionState)
          .executeTakeFirst();
        expectOne(sessionUpdate.numUpdatedRows, "failing a cancelling session");
      }
    });

    if (shouldRetry) {
      return {
        status: "retry_scheduled",
        controlRequestId: claim.request.controlRequestId,
        targetRunId: claim.request.target.runId,
        sessionId: claim.request.target.sessionId,
        turnId: claim.request.target.turnId,
        attempt: claim.attempt,
        failureCode: failure.code,
      };
    }
    return {
      status: "failed",
      controlRequestId: claim.request.controlRequestId,
      targetRunId: claim.request.target.runId,
      sessionId: claim.request.target.sessionId,
      turnId: claim.request.target.turnId,
      attempt: claim.attempt,
      phase: started ? "after_start" : "before_start",
      failureCode: failure.code,
    };
  }

  async #lockLifecycleRows(
    transaction: Transaction<Database>,
    claim: ClaimedCancellation,
  ): Promise<CancellationLifecycleRows> {
    const row = await transaction
      .selectFrom("turn_control_requests as cancellation")
      .innerJoin("turns as turn", (join) =>
        join
          .onRef("turn.tenant_id", "=", "cancellation.tenant_id")
          .onRef("turn.session_id", "=", "cancellation.session_id")
          .onRef("turn.id", "=", "cancellation.turn_id"),
      )
      .innerJoin("sessions as session_row", (join) =>
        join
          .onRef("session_row.tenant_id", "=", "cancellation.tenant_id")
          .onRef("session_row.id", "=", "cancellation.session_id"),
      )
      .innerJoin("runs as run", (join) =>
        join
          .onRef("run.tenant_id", "=", "cancellation.tenant_id")
          .onRef("run.session_id", "=", "cancellation.session_id")
          .onRef("run.turn_id", "=", "cancellation.turn_id")
          .onRef("run.id", "=", "cancellation.target_run_id"),
      )
      .innerJoin("run_attempts as run_attempt", (join) =>
        join
          .onRef("run_attempt.run_id", "=", "run.id")
          .onRef("run_attempt.id", "=", "run.current_attempt_id"),
      )
      .select([
        "cancellation.state as cancellationTurnControlRequestState",
        "turn.state as turnState",
        "session_row.state as sessionState",
        "cancellation.attempts as controlAttempts",
        "run.state as runState",
        "run.current_attempt_id as currentAttemptId",
        "run_attempt.state as runAttemptState",
      ])
      .where("cancellation.tenant_id", "=", claim.request.target.tenantId)
      .where("cancellation.id", "=", claim.request.controlRequestId)
      .where("turn.id", "=", claim.request.target.turnId)
      .where("session_row.id", "=", claim.request.target.sessionId)
      .where("run.id", "=", claim.request.target.runId)
      .where("run_attempt.id", "=", claim.request.target.attemptId)
      .forUpdate(["cancellation", "turn", "session_row", "run", "run_attempt"])
      .executeTakeFirst();
    if (row === undefined) {
      throw new RunCancellationExecutorInvariantError(
        "Claimed cancellation lifecycle rows are missing",
      );
    }
    if (row.controlAttempts !== claim.attempt) {
      throw new RunCancellationExecutorStaleClaimError(
        `Cancellation claim attempt ${claim.attempt} was superseded by attempt ${row.controlAttempts}`,
      );
    }
    if (row.currentAttemptId !== claim.request.target.attemptId) {
      throw new RunCancellationExecutorStaleClaimError(
        "Cancellation target attempt was superseded",
      );
    }
    return row;
  }
}
