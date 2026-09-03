import type { Database } from "@pi-cloud/database";
import {
  isTerminalRunAttemptState,
  transitionRun,
  transitionRunAttempt,
  transitionSession,
  transitionTurn,
  type SessionState,
  type TurnState,
} from "@pi-cloud/domain";
import {
  parseCloudToolCapabilitySnapshot,
  parseEnvironmentRuntimeSnapshot,
} from "@pi-cloud/protocol";
import type {
  AgentRevisionSnapshot,
  AgentRuntimeKind,
  CancelTurnCommandMessage,
  CloudToolCapabilitySnapshot,
  TurnBudgetSnapshot,
} from "@pi-cloud/protocol";
import type { EnvironmentRuntimeSnapshot, TraceContext } from "@pi-cloud/protocol";
import { virtualRunTraceCarrier, withSpan } from "@pi-cloud/observability";
import type { PiCloudMetrics } from "@pi-cloud/observability";
import { sql, type Kysely, type Transaction } from "kysely";
import { randomUUID } from "node:crypto";
import { transitionCurrentRunAttempt } from "./run-attempt-state.ts";
import { commitTerminalTurnEvent } from "./terminal-turn-event.ts";
import type {
  PreparedTerminalTurnProjection,
  TerminalTurnProjectionSource,
} from "./terminal-turn-projection.ts";

const DEFAULT_CLAIM_LEASE_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
export type TurnExecutionRequest = {
  tenantId: string;
  projectId: string;
  workspaceId: string;
  sessionId: string;
  piSessionId: string;
  piSessionLane: string;
  runId: string;
  turnId: string;
  attemptId: string;
  attemptNumber: number;
  agent: AgentRevisionSnapshot;
  idempotencyKey: string;
  nextEventSeq: string;
  input: {
    kind: "prompt";
    prompt: string;
  };
  executionMode: import("@pi-cloud/protocol").ExecutionMode;
  sandboxProfileKey: import("@pi-cloud/protocol").DevelopmentEnvironmentProfileKey;
  workingDirectory: string;
  toolCapabilities: CloudToolCapabilitySnapshot;
  agentSystemPrompt?: string;
  model: {
    profileId: string;
    provider: string;
    modelId: string;
    thinkingLevel: string;
    serviceTier: "fast" | null;
    credentialBindingId: string;
    credentialBindingVersion: string;
  };
  environment: EnvironmentRuntimeSnapshot;
  budgets?: TurnBudgetSnapshot;
  traceContext?: TraceContext;
};

export type TurnExecutionLease = {
  executionLease: string;
};

export type TurnExecutionLifecycle = {
  started(grant?: TurnExecutionLease): Promise<void>;
};

export type TurnExecutionResult = {
  stopReason: string;
  lastEventSeq?: number;
};

export interface TurnExecutionBackend {
  execute(
    request: TurnExecutionRequest,
    lifecycle: TurnExecutionLifecycle,
  ): Promise<TurnExecutionResult>;
}

export interface TurnExecutionAuthority {
  assertCurrent(
    transaction: Transaction<Database>,
    request: TurnExecutionRequest,
    grant: TurnExecutionLease,
    now: Date,
  ): Promise<void>;
  assertCurrentOrExpired?(
    transaction: Transaction<Database>,
    request: TurnExecutionRequest,
    grant: TurnExecutionLease,
    now: Date,
  ): Promise<void>;
  releaseCurrent(
    transaction: Transaction<Database>,
    request: TurnExecutionRequest,
    grant: TurnExecutionLease,
    now: Date,
  ): Promise<void>;
}

export class TurnExecutionBackendError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly quarantineSession: boolean;
  lastEventSeq: number | undefined;

  constructor(
    code: string,
    safeMessage: string,
    retryable: boolean,
    quarantineSession = false,
    lastEventSeq?: number,
  ) {
    super(safeMessage);
    this.name = "TurnExecutionBackendError";
    this.code = code;
    this.retryable = retryable;
    this.quarantineSession = quarantineSession;
    this.lastEventSeq = lastEventSeq;
  }
}

export class TurnExecutionCancelledError extends TurnExecutionBackendError {
  readonly reason: CancelTurnCommandMessage["payload"]["reason"];
  readonly forced: boolean;

  constructor(reason: CancelTurnCommandMessage["payload"]["reason"], forced: boolean) {
    const code =
      reason === "timeout"
        ? "pi_timeout"
        : reason === "shutdown"
          ? "worker_shutdown"
          : "turn_cancelled";
    const message =
      reason === "timeout"
        ? "Pi turn exceeded its execution deadline"
        : reason === "shutdown"
          ? "Pi Worker shut down before the turn settled"
          : "Turn cancellation was confirmed";
    super(code, message, false);
    this.name = "TurnExecutionCancelledError";
    this.reason = reason;
    this.forced = forced;
  }
}

export class RunExecutorInvariantError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunExecutorInvariantError";
  }
}

export class RunExecutorStaleClaimError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunExecutorStaleClaimError";
  }
}

export type RunExecutionResult =
  | { status: "idle" }
  | {
      status: "cancellation_pending" | "cancelled";
      runId: string;
      sessionId: string;
      turnId: string;
      attempt: number;
    }
  | {
      status: "completed";
      runId: string;
      sessionId: string;
      turnId: string;
      attempt: number;
    }
  | {
      status: "retry_scheduled";
      runId: string;
      sessionId: string;
      turnId: string;
      attempt: number;
      failureCode: string;
    }
  | {
      status: "failed";
      runId: string;
      sessionId: string;
      turnId: string;
      attempt: number;
      phase: "before_start" | "after_start";
      failureCode: string;
    };

export type RunExecutorOptions = {
  database: Kysely<Database>;
  backend: TurnExecutionBackend;
  clock?: () => Date;
  claimLeaseMs?: number;
  maxAttempts?: number;
  claimOwnerId?: string;
  idGenerator?: () => string;
  executionAuthority?: TurnExecutionAuthority;
  metrics?: PiCloudMetrics;
  terminalTurnProjectionSource?: TerminalTurnProjectionSource;
  agentRuntimeKind?: AgentRuntimeKind;
};

type ClaimedTurn = {
  attempt: number;
  request: TurnExecutionRequest;
  queuedAt: Date;
};

type LifecycleRows = {
  turnState: TurnState;
  sessionState: SessionState;
  runState: import("@pi-cloud/domain").RunState;
  runFailureCode: string | null;
  runVersion: string;
  runAttemptCount: number;
  currentAttemptId: string | null;
  runAttemptState: import("@pi-cloud/domain").RunAttemptState;
};

type ExecutionFailure = {
  code: string;
  safeMessage: string;
  retryable: boolean;
  quarantineSession: boolean;
  lastEventSeq?: number;
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function safeMailboxPosition(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RunExecutorInvariantError(
      "The v1 turn dispatcher requires a positive mailbox position",
    );
  }
  return parsed;
}

function safeNonNegativeInteger(value: number | string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RunExecutorInvariantError(`${name} must be a non-negative safe integer`);
  }
  return parsed;
}

function safeDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("dispatcher clock must return a valid Date");
  }
  return value;
}

function normalizeFailure(error: unknown): ExecutionFailure {
  if (error instanceof TurnExecutionBackendError) {
    return {
      code: error.code,
      safeMessage: error.message,
      retryable: error.retryable,
      quarantineSession: error.quarantineSession,
      ...(error.lastEventSeq === undefined ? {} : { lastEventSeq: error.lastEventSeq }),
    };
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string" &&
    "retryable" in error &&
    typeof error.retryable === "boolean"
  ) {
    return {
      code: error.code,
      safeMessage: error instanceof Error ? error.message : "Execution backend failed",
      retryable: error.retryable,
      quarantineSession:
        "quarantineSession" in error && typeof error.quarantineSession === "boolean"
          ? error.quarantineSession
          : false,
      ...("lastEventSeq" in error &&
      typeof error.lastEventSeq === "number" &&
      Number.isSafeInteger(error.lastEventSeq) &&
      error.lastEventSeq >= 0
        ? { lastEventSeq: error.lastEventSeq }
        : {}),
    };
  }
  return {
    code: "execution_backend_error",
    safeMessage: "Execution backend failed",
    retryable: true,
    quarantineSession: false,
  };
}

function expectOne(updatedRows: bigint, description: string): void {
  if (updatedRows !== 1n) {
    throw new RunExecutorInvariantError(`${description} changed ${updatedRows} rows`);
  }
}

export class RunExecutor {
  readonly #database: Kysely<Database>;
  readonly #backend: TurnExecutionBackend;
  readonly #clock: () => Date;
  readonly #claimLeaseMs: number;
  readonly #maxAttempts: number;
  readonly #claimOwnerId: string;
  readonly #idGenerator: () => string;
  readonly #executionAuthority: TurnExecutionAuthority | undefined;
  readonly #metrics: PiCloudMetrics | undefined;
  readonly #terminalTurnProjectionSource: TerminalTurnProjectionSource | undefined;
  readonly #agentRuntimeKind: AgentRuntimeKind;

  constructor(options: RunExecutorOptions) {
    this.#database = options.database;
    this.#backend = options.backend;
    this.#clock = options.clock ?? (() => new Date());
    this.#claimLeaseMs = positiveInteger(
      options.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS,
      "claimLeaseMs",
    );
    this.#maxAttempts = positiveInteger(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS, "maxAttempts");
    this.#claimOwnerId = options.claimOwnerId ?? "control-plane";
    if (
      this.#claimOwnerId.length < 1 ||
      this.#claimOwnerId.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(this.#claimOwnerId)
    ) {
      throw new TypeError("claimOwnerId is invalid");
    }
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#executionAuthority = options.executionAuthority;
    this.#metrics = options.metrics;
    this.#terminalTurnProjectionSource = options.terminalTurnProjectionSource;
    this.#agentRuntimeKind = options.agentRuntimeKind ?? "pi_sdk";
  }

  /**
   * Executes one durable Run selected by the PostgreSQL Worker queue. This component
   * owns transactional admission and lifecycle commits; it never chooses
   * between tenants, Sessions, or Runs.
   */
  async dispatchRun(runId: string): Promise<RunExecutionResult> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
      throw new TypeError("runId must be a UUID");
    }
    return this.#dispatch(runId.toLowerCase());
  }

  async dispatchNext(sessionKind: "conversation" | "subagent"): Promise<RunExecutionResult> {
    return this.#dispatch(undefined, sessionKind);
  }

  async #dispatch(
    runId?: string,
    sessionKind?: "conversation" | "subagent",
  ): Promise<RunExecutionResult> {
    const claimStartedAt = performance.now();
    let claim: ClaimedTurn | undefined;
    try {
      claim = await this.#claimNext(runId, sessionKind);
      this.#metrics?.runClaimDuration.observe(
        { outcome: claim === undefined ? "idle" : "claimed" },
        (performance.now() - claimStartedAt) / 1_000,
      );
    } catch (error: unknown) {
      this.#metrics?.runClaimDuration.observe(
        { outcome: "failed" },
        (performance.now() - claimStartedAt) / 1_000,
      );
      throw error;
    }
    if (!claim) return { status: "idle" };

    const observedAt = safeDate(this.#clock).valueOf();
    this.#metrics?.queueWait.observe(Math.max(0, observedAt - claim.queuedAt.valueOf()) / 1_000);
    this.#metrics?.activeRuns.inc();
    const executionStartedAt = performance.now();
    try {
      const result = await withSpan<RunExecutionResult>({
        serviceName: "pi-cloud-control-plane",
        name: "run.dispatch",
        ...(claim.request.traceContext === undefined ? {} : { parent: claim.request.traceContext }),
        attributes: {
          "pi_cloud.run.id": claim.request.runId,
          "pi_cloud.attempt.id": claim.request.attemptId,
          "pi_cloud.session.id": claim.request.sessionId,
        },
        run: async () => {
          let started = false;
          let acknowledgement: TurnExecutionLease | undefined;
          let startedPromise: Promise<void> | undefined;
          let startFailure: unknown;
          const lifecycle: TurnExecutionLifecycle = {
            started: (candidate) => {
              if (this.#executionAuthority !== undefined && candidate === undefined) {
                return Promise.reject(
                  new RunExecutorInvariantError(
                    "A fenced execution acknowledgement is required by the configured lease manager",
                  ),
                );
              }
              if (
                startedPromise !== undefined &&
                candidate?.executionLease !== acknowledgement?.executionLease
              ) {
                return Promise.reject(
                  new RunExecutorInvariantError("Execution acknowledgement changed after start"),
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

          let executionResult: TurnExecutionResult;
          try {
            executionResult = await this.#backend.execute(claim.request, lifecycle);
            if (startedPromise) await startedPromise;
            if (!started) {
              throw new TurnExecutionBackendError(
                "backend_protocol_violation",
                "Execution backend returned before acknowledging the Run",
                false,
              );
            }
            if (
              typeof executionResult.stopReason !== "string" ||
              executionResult.stopReason.trim().length === 0 ||
              executionResult.stopReason.length > 256
            ) {
              throw new TurnExecutionBackendError(
                "backend_protocol_violation",
                "Execution backend returned an invalid stop reason",
                false,
              );
            }
          } catch (error) {
            if (startedPromise && !started && startFailure === undefined) {
              try {
                await startedPromise;
              } catch {
                // The persistence error is rethrown below instead of being recorded as an agent failure.
              }
            }
            if (startFailure !== undefined) throw startFailure;
            if (started) {
              const externallySettled = await this.#observeCancellation(claim);
              if (externallySettled !== undefined) return externallySettled;
              if (error instanceof TurnExecutionCancelledError && error.reason === "user_request") {
                throw new RunExecutorInvariantError(
                  "Cancellation confirmation arrived before its durable lifecycle",
                );
              }
            }
            return this.#recordFailure(claim, started, normalizeFailure(error), acknowledgement);
          }

          await this.#complete(claim, executionResult, acknowledgement);
          return {
            status: "completed",
            runId: claim.request.runId,
            sessionId: claim.request.sessionId,
            turnId: claim.request.turnId,
            attempt: claim.attempt,
          };
        },
      });
      this.#metrics?.runs.inc({ outcome: result.status });
      this.#metrics?.runDuration.observe(
        { outcome: result.status },
        (performance.now() - executionStartedAt) / 1_000,
      );
      return result;
    } catch (error: unknown) {
      this.#metrics?.runs.inc({ outcome: "dispatcher_error" });
      this.#metrics?.runDuration.observe(
        { outcome: "dispatcher_error" },
        (performance.now() - executionStartedAt) / 1_000,
      );
      throw error;
    } finally {
      this.#metrics?.activeRuns.dec();
    }
  }

  async #observeCancellation(claim: ClaimedTurn): Promise<RunExecutionResult | undefined> {
    return this.#database.transaction().execute(async (transaction) => {
      const rows = await this.#lockLifecycleRows(transaction, claim);
      if (
        rows.runState === "cancel_requested" &&
        rows.turnState === "cancelling" &&
        rows.sessionState === "cancelling"
      ) {
        return {
          status: "cancellation_pending",
          runId: claim.request.runId,
          sessionId: claim.request.sessionId,
          turnId: claim.request.turnId,
          attempt: claim.attempt,
        };
      }
      if (
        rows.runState === "cancelled" &&
        rows.turnState === "cancelled" &&
        rows.sessionState === "idle"
      ) {
        return {
          status: "cancelled",
          runId: claim.request.runId,
          sessionId: claim.request.sessionId,
          turnId: claim.request.turnId,
          attempt: claim.attempt,
        };
      }
      if (
        rows.runState === "failed" &&
        rows.turnState === "failed" &&
        rows.sessionState === "failed"
      ) {
        return {
          status: "failed",
          runId: claim.request.runId,
          sessionId: claim.request.sessionId,
          turnId: claim.request.turnId,
          attempt: claim.attempt,
          phase: "after_start",
          failureCode: rows.runFailureCode ?? "cancellation_failed",
        };
      }
      return undefined;
    });
  }

  async #claimNext(
    runId?: string,
    sessionKind?: "conversation" | "subagent",
  ): Promise<ClaimedTurn | undefined> {
    const now = safeDate(this.#clock);
    const leaseUntil = new Date(now.valueOf() + this.#claimLeaseMs);

    return this.#database.transaction().execute(async (transaction) => {
      let selectedRunId = runId;
      if (selectedRunId === undefined) {
        const candidate = await transaction
          .selectFrom("runs as candidate")
          .innerJoin(
            "agent_revisions as candidate_agent",
            "candidate_agent.id",
            "candidate.agent_revision_id",
          )
          .innerJoin("sessions as candidate_session", (join) =>
            join
              .onRef("candidate_session.tenant_id", "=", "candidate.tenant_id")
              .onRef("candidate_session.id", "=", "candidate.session_id"),
          )
          .innerJoin(
            "tenant_runtime_policies as candidate_policy",
            "candidate_policy.tenant_id",
            "candidate.tenant_id",
          )
          .select("candidate.id")
          .where("candidate.available_at", "<=", now)
          .where("candidate.state", "in", ["queued", "claimed"])
          .where("candidate_session.state", "in", ["cold", "idle"])
          .where("candidate_session.session_kind", "=", sessionKind!)
          .where("candidate_policy.enabled", "=", true)
          .where("candidate_agent.runtime_kind", "=", this.#agentRuntimeKind)
          .where(
            sql<boolean>`not exists (
              select 1
              from runs as active_run
              where active_run.tenant_id = ${sql.ref("candidate.tenant_id")}
                and active_run.session_id = ${sql.ref("candidate.session_id")}
                and active_run.id <> ${sql.ref("candidate.id")}
                and active_run.state in (
                  'claimed', 'provisioning', 'restoring', 'running', 'settling', 'cancel_requested'
                )
            )`,
          )
          .where(
            sql<boolean>`not exists (
              select 1
              from runs as earlier_run
              where earlier_run.tenant_id = ${sql.ref("candidate.tenant_id")}
                and earlier_run.session_id = ${sql.ref("candidate.session_id")}
                and earlier_run.state not in ('completed', 'failed', 'cancelled', 'timed_out', 'superseded')
                and earlier_run.mailbox_position < ${sql.ref("candidate.mailbox_position")}
            )`,
          )
          .orderBy("candidate.available_at", "asc")
          .orderBy("candidate.queued_at", "asc")
          .orderBy("candidate.id", "asc")
          .limit(1)
          .forUpdate("candidate")
          .skipLocked()
          .executeTakeFirst();
        if (candidate === undefined) return undefined;
        selectedRunId = candidate.id;
      }
      const row = await transaction
        .selectFrom("runs as run")
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
        .innerJoin("turns as turn", (join) =>
          join
            .onRef("turn.tenant_id", "=", "run.tenant_id")
            .onRef("turn.session_id", "=", "run.session_id")
            .onRef("turn.id", "=", "run.turn_id"),
        )
        .innerJoin("sessions as session_row", (join) =>
          join
            .onRef("session_row.tenant_id", "=", "run.tenant_id")
            .onRef("session_row.id", "=", "run.session_id"),
        )
        .innerJoin("workspaces as workspace_row", (join) =>
          join
            .onRef("workspace_row.tenant_id", "=", "session_row.tenant_id")
            .onRef("workspace_row.id", "=", "session_row.workspace_id"),
        )
        .innerJoin("environment_versions as environment", (join) =>
          join
            .onRef("environment.tenant_id", "=", "run.tenant_id")
            .onRef("environment.project_id", "=", "run.project_id")
            .onRef("environment.id", "=", "run.environment_version_id"),
        )
        .innerJoin("tenant_runtime_policies as policy", "policy.tenant_id", "run.tenant_id")
        .select([
          "run.tenant_id as tenantId",
          "run.agent_revision_id as agentRevisionId",
          "agent_definition.key as agentDefinitionKey",
          "agent_revision.runtime_kind as agentRuntimeKind",
          "agent_revision.runtime_version as agentRuntimeVersion",
          "agent_revision.harness_version as agentHarnessVersion",
          "agent_revision.session_storage_kind as agentSessionStorageKind",
          "run.idempotency_key as idempotencyKey",
          "run.mailbox_position as mailboxPosition",
          "turn.id as turnId",
          "turn.state as turnState",
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
          "session_row.state as sessionState",
          "session_row.session_kind as sessionKind",
          "session_row.execution_mode as executionMode",
          "session_row.project_id as projectId",
          "session_row.workspace_id as workspaceId",
          "session_row.next_event_seq as nextEventSeq",
          "session_row.current_workspace_settlement_id as sessionWorkspaceSettlementId",
          "session_row.forked_from_session_id as forkedFromSessionId",
          "workspace_row.current_workspace_settlement_id as currentWorkspaceSettlementId",
          "run.id as runId",
          "run.trace_id as traceId",
          "run.tool_capability_snapshot as toolCapabilitySnapshot",
          "run.agent_system_prompt as agentSystemPrompt",
          "run.working_directory as workingDirectory",
          "run.sandbox_profile_key as sandboxProfileKey",
          "run.queued_at as runQueuedAt",
          "run.state as runState",
          "run.current_attempt_id as currentAttemptId",
          "run.attempt_count as runAttemptCount",
          "run.row_version as runVersion",
          "environment.id as environmentVersionId",
          "environment.version_number as environmentVersionNumber",
          "environment.profile_key as environmentProfileKey",
          "environment.profile_version as environmentProfileVersion",
          "environment.image_revision as environmentImageRevision",
          "environment.spec_sha256 as environmentSpecSha256",
          "environment.recipe as environmentRecipe",
          "environment.recipe_sha256 as environmentRecipeSha256",
          "policy.maximum_model_requests_per_run as maximumModelRequests",
          "policy.maximum_cost_microusd_per_run as maximumCostMicrousd",
          "policy.daily_token_budget as dailyTokenBudget",
          "policy.monthly_cost_microusd_budget as monthlyCostMicrousdBudget",
          "policy.maximum_tool_calls_per_run as maximumToolCalls",
          "policy.maximum_tool_output_bytes as maximumToolOutputBytes",
          "policy.maximum_run_duration_ms as maximumRunDurationMs",
          "policy.compaction_reserve_tokens as compactionReserveTokens",
          "policy.compaction_keep_recent_tokens as compactionKeepRecentTokens",
        ])
        .where("workspace_row.deleted_at", "is", null)
        .where("agent_revision.runtime_kind", "=", this.#agentRuntimeKind)
        .whereRef("session_row.agent_revision_id", "=", "run.agent_revision_id")
        .where("policy.enabled", "=", true)
        .where("run.available_at", "<=", now)
        .where("run.id", "=", selectedRunId)
        .$if(sessionKind !== undefined, (query) =>
          query.where("session_row.session_kind", "=", sessionKind!),
        )
        .where("run.state", "in", ["queued", "claimed"])
        .where("turn.state", "=", "queued")
        .where(
          sql<boolean>`not exists (
            select 1
            from runs as active_run
            where active_run.tenant_id = ${sql.ref("run.tenant_id")}
              and active_run.session_id = ${sql.ref("run.session_id")}
              and active_run.id <> ${sql.ref("run.id")}
              and active_run.state in (
                'claimed', 'provisioning', 'restoring', 'running', 'settling', 'cancel_requested'
              )
          )`,
        )
        .where(
          sql<boolean>`not exists (
            select 1
            from runs as earlier_run
            where earlier_run.tenant_id = ${sql.ref("run.tenant_id")}
              and earlier_run.session_id = ${sql.ref("run.session_id")}
              and earlier_run.state not in ('completed', 'failed', 'cancelled', 'timed_out', 'superseded')
              and earlier_run.mailbox_position < ${sql.ref("run.mailbox_position")}
          )`,
        )
        .where("session_row.state", "in", ["cold", "idle"])
        .orderBy("run.available_at", "asc")
        .orderBy("run.queued_at", "asc")
        .orderBy("run.id", "asc")
        .limit(1)
        .forUpdate("run")
        .skipLocked()
        .executeTakeFirst();

      if (!row) return undefined;

      if (row.inputKind !== "prompt" || row.inputText === null) {
        throw new RunExecutorInvariantError(
          "The v1 turn dispatcher only accepts durable prompt turns",
        );
      }
      safeMailboxPosition(row.mailboxPosition);

      const maximumToolCalls = safeNonNegativeInteger(row.maximumToolCalls, "tool-call budget");
      // A post-ACK attempt is never blindly replayed. Pre-ACK retries cannot
      // have executed a Tool, so every newly claimed execution starts with the
      // full per-Run budget. The trusted Runner decrements it in memory while
      // the Agent Loop is active.
      const remainingToolCalls = maximumToolCalls;
      const toolCapabilities = parseCloudToolCapabilitySnapshot(row.toolCapabilitySnapshot);

      const attemptNumber = row.runAttemptCount + 1;
      if (row.currentAttemptId !== null) {
        const previous = await transaction
          .selectFrom("run_attempts")
          .select(["state"])
          .where("tenant_id", "=", row.tenantId)
          .where("run_id", "=", row.runId)
          .where("id", "=", row.currentAttemptId)
          .forUpdate()
          .executeTakeFirst();
        if (previous === undefined) {
          throw new RunExecutorInvariantError("Current run attempt is missing");
        }
        if (!isTerminalRunAttemptState(previous.state)) {
          const superseded = await transaction
            .updateTable("run_attempts")
            .set({ state: "superseded", settled_at: now, updated_at: now })
            .where("tenant_id", "=", row.tenantId)
            .where("run_id", "=", row.runId)
            .where("id", "=", row.currentAttemptId)
            .where("state", "=", previous.state)
            .executeTakeFirst();
          expectOne(superseded.numUpdatedRows, "superseding a stale run attempt");
          await transaction
            .insertInto("run_attempt_transitions")
            .values({
              id: this.#idGenerator(),
              tenant_id: row.tenantId,
              run_id: row.runId,
              attempt_id: row.currentAttemptId,
              from_state: previous.state,
              to_state: "superseded",
              reason: "run_claim_expired",
              occurred_at: now,
            })
            .executeTakeFirstOrThrow();
        }
      }
      const attemptId = this.#idGenerator();
      const transitionId = this.#idGenerator();
      const workspaceBaseSettlementId =
        row.forkedFromSessionId === null
          ? row.currentWorkspaceSettlementId
          : row.sessionWorkspaceSettlementId;
      const claimed = await sql<{
        attemptCount: number;
        transitionCount: number;
        runCount: number;
      }>`
        with inserted_attempt as (
          insert into run_attempts (
            id, tenant_id, run_id, attempt_number, state, claim_owner_id,
            claim_expires_at, last_event_seq, claimed_at, created_at, updated_at
          ) values (
            ${attemptId}::uuid, ${row.tenantId}::uuid, ${row.runId}::uuid,
            ${attemptNumber}, 'claimed', ${this.#claimOwnerId}, ${leaseUntil},
            ${Math.max(0, Number(row.nextEventSeq) - 1)}::bigint, ${now}, ${now}, ${now}
          )
          returning id
        ), inserted_transition as (
          insert into run_attempt_transitions (
            id, tenant_id, run_id, attempt_id, from_state, to_state, reason, occurred_at
          )
          select ${transitionId}::uuid, ${row.tenantId}::uuid, ${row.runId}::uuid,
                 id, null, 'claimed', 'run_claimed', ${now}
            from inserted_attempt
          returning id
        ), updated_run as (
          update runs
             set state = 'claimed',
                 available_at = ${leaseUntil},
                 current_attempt_id = ${attemptId}::uuid,
                 attempt_count = ${attemptNumber},
                 workspace_base_settlement_id = ${workspaceBaseSettlementId}::uuid,
                 stop_reason = null,
                 failure_code = null,
                 failure_message = null,
                 failure_retryable = null,
                 settled_at = null,
                 row_version = row_version + 1,
                 updated_at = ${now}
           where tenant_id = ${row.tenantId}::uuid
             and id = ${row.runId}::uuid
             and row_version = ${row.runVersion}::bigint
             and attempt_count = ${row.runAttemptCount}
          returning id
        )
        select (select count(*)::int from inserted_attempt) as "attemptCount",
               (select count(*)::int from inserted_transition) as "transitionCount",
               (select count(*)::int from updated_run) as "runCount"
      `.execute(transaction);
      const claimCounts = claimed.rows[0];
      if (
        claimCounts?.attemptCount !== 1 ||
        claimCounts.transitionCount !== 1 ||
        claimCounts.runCount !== 1
      ) {
        throw new RunExecutorInvariantError("Run claim did not commit one atomic lifecycle");
      }

      return {
        attempt: attemptNumber,
        queuedAt: new Date(row.runQueuedAt),
        request: {
          tenantId: row.tenantId,
          projectId: row.projectId,
          workspaceId: row.workspaceId,
          sessionId: row.sessionId,
          piSessionId: row.piSessionId,
          piSessionLane: row.piSessionLane,
          runId: row.runId,
          turnId: row.turnId,
          attemptId,
          attemptNumber,
          agent: {
            revisionId: row.agentRevisionId,
            definitionKey: row.agentDefinitionKey,
            runtimeKind: row.agentRuntimeKind,
            runtimeVersion: row.agentRuntimeVersion,
            harnessVersion: row.agentHarnessVersion,
            sessionStorageKind: row.agentSessionStorageKind,
          },
          idempotencyKey: row.idempotencyKey,
          nextEventSeq: row.nextEventSeq,
          input: { kind: "prompt", prompt: row.inputText },
          executionMode: row.executionMode,
          sandboxProfileKey: row.sandboxProfileKey,
          workingDirectory: row.workingDirectory,
          toolCapabilities,
          ...(row.agentSystemPrompt === null ? {} : { agentSystemPrompt: row.agentSystemPrompt }),
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
          budgets: {
            maximumModelRequests: safeNonNegativeInteger(
              row.maximumModelRequests,
              "model-request budget",
            ),
            maximumCostMicrousd: safeNonNegativeInteger(row.maximumCostMicrousd, "run cost budget"),
            dailyTokenBudget: safeNonNegativeInteger(row.dailyTokenBudget, "daily token budget"),
            monthlyCostMicrousdBudget: safeNonNegativeInteger(
              row.monthlyCostMicrousdBudget,
              "monthly cost budget",
            ),
            maximumToolCalls,
            remainingToolCalls,
            maximumToolOutputBytes: safeNonNegativeInteger(
              row.maximumToolOutputBytes,
              "tool output budget",
            ),
            maximumRunDurationMs: safeNonNegativeInteger(
              row.maximumRunDurationMs,
              "Run duration budget",
            ),
            compactionReserveTokens: safeNonNegativeInteger(
              row.compactionReserveTokens,
              "compaction reserve",
            ),
            compactionKeepRecentTokens: safeNonNegativeInteger(
              row.compactionKeepRecentTokens,
              "compaction recent context",
            ),
          },
          traceContext: virtualRunTraceCarrier(
            row.traceId,
            attemptId.replaceAll("-", "").slice(0, 16),
          ),
        },
      };
    });
  }

  async #markStarted(
    claim: ClaimedTurn,
    acknowledgement: TurnExecutionLease | undefined,
  ): Promise<void> {
    const now = safeDate(this.#clock);
    await this.#database.transaction().execute(async (transaction) => {
      const rows = await this.#lockLifecycleRows(transaction, claim);
      if (rows.runState !== "claimed" || rows.turnState !== "queued") {
        throw new RunExecutorInvariantError("Only a claimed Run with a queued Turn can start");
      }
      if (this.#executionAuthority !== undefined && acknowledgement !== undefined) {
        await this.#executionAuthority.assertCurrent(
          transaction,
          claim.request,
          acknowledgement,
          now,
        );
      }
      await transitionCurrentRunAttempt(
        transaction,
        {
          tenantId: claim.request.tenantId,
          runId: claim.request.runId,
          attemptId: claim.request.attemptId,
        },
        {
          runState: "provisioning",
          attemptState: "provisioning",
          reason: "run_started",
          now,
          heartbeat: true,
          transitionId: this.#idGenerator(),
        },
      );

      let nextSessionState: SessionState;
      if (rows.sessionState === "cold") {
        const starting = transitionSession(rows.sessionState, "starting");
        const idle = transitionSession(starting, "idle");
        nextSessionState = transitionSession(idle, "running");
      } else if (rows.sessionState === "idle") {
        nextSessionState = transitionSession(rows.sessionState, "running");
      } else {
        throw new RunExecutorInvariantError(
          `Session cannot start a turn from ${rows.sessionState}`,
        );
      }

      const turnUpdate = await transaction
        .updateTable("turns")
        .set({
          state: transitionTurn(rows.turnState, "running"),
          started_at: now,
        })
        .where("tenant_id", "=", claim.request.tenantId)
        .where("id", "=", claim.request.turnId)
        .where("state", "=", rows.turnState)
        .executeTakeFirst();
      expectOne(turnUpdate.numUpdatedRows, "starting a turn");

      const sessionUpdate = await transaction
        .updateTable("sessions")
        .set({
          state: nextSessionState,
          row_version: sql<string>`${sql.ref("row_version")} + 1`,
          updated_at: now,
          last_active_at: now,
        })
        .where("tenant_id", "=", claim.request.tenantId)
        .where("id", "=", claim.request.sessionId)
        .where("state", "=", rows.sessionState)
        .executeTakeFirst();
      expectOne(sessionUpdate.numUpdatedRows, "starting a session");
    });
  }

  async #complete(
    claim: ClaimedTurn,
    result: TurnExecutionResult,
    acknowledgement: TurnExecutionLease | undefined,
  ): Promise<void> {
    const now = safeDate(this.#clock);
    const terminalEventId = this.#idGenerator();
    const terminalBody = {
      type: "turn.completed",
      payload: {
        stopReason: result.stopReason,
      },
    } as const;
    await this.#database.transaction().execute(async (transaction) => {
      const rows = await this.#lockLifecycleRows(transaction, claim);
      if (
        !["provisioning", "restoring", "running", "settling"].includes(rows.runState) ||
        rows.turnState !== "running" ||
        rows.sessionState !== "running"
      ) {
        throw new RunExecutorInvariantError("Only a running Run can complete");
      }

      if (this.#executionAuthority !== undefined && acknowledgement !== undefined) {
        await this.#executionAuthority.assertCurrent(
          transaction,
          claim.request,
          acknowledgement,
          now,
        );
      }
      await this.#storeEventBoundary(
        transaction,
        claim,
        result.lastEventSeq ?? Number(claim.request.nextEventSeq) - 1,
        now,
      );
      if (rows.runAttemptState === "provisioning" || rows.runAttemptState === "restoring") {
        await transitionCurrentRunAttempt(
          transaction,
          {
            tenantId: claim.request.tenantId,
            runId: claim.request.runId,
            attemptId: claim.request.attemptId,
          },
          {
            runState: "running",
            attemptState: "running",
            reason: "backend_settled_without_phase_signal",
            now,
            transitionId: this.#idGenerator(),
          },
        );
      }
      await transitionCurrentRunAttempt(
        transaction,
        {
          tenantId: claim.request.tenantId,
          runId: claim.request.runId,
          attemptId: claim.request.attemptId,
        },
        {
          runState: "completed",
          attemptState: "completed",
          reason: "execution_completed",
          now,
          stopReason: result.stopReason,
          transitionId: this.#idGenerator(),
        },
      );

      const turnUpdate = await transaction
        .updateTable("turns")
        .set({
          state: transitionTurn(rows.turnState, "completed"),
          stop_reason: result.stopReason,
          settled_at: now,
        })
        .where("tenant_id", "=", claim.request.tenantId)
        .where("id", "=", claim.request.turnId)
        .where("state", "=", rows.turnState)
        .executeTakeFirst();
      expectOne(turnUpdate.numUpdatedRows, "completing a turn");

      const sessionUpdate = await transaction
        .updateTable("sessions")
        .set({
          state: transitionSession(rows.sessionState, "idle"),
          row_version: sql<string>`${sql.ref("row_version")} + 1`,
          updated_at: now,
          last_active_at: now,
        })
        .where("tenant_id", "=", claim.request.tenantId)
        .where("id", "=", claim.request.sessionId)
        .where("state", "=", rows.sessionState)
        .executeTakeFirst();
      expectOne(sessionUpdate.numUpdatedRows, "settling a session");
      await commitTerminalTurnEvent(transaction, {
        tenantId: claim.request.tenantId,
        sessionId: claim.request.sessionId,
        turnId: claim.request.turnId,
        runId: claim.request.runId,
        agentId: "root",
        body: terminalBody,
        now,
        eventId: terminalEventId,
      });
      if (this.#executionAuthority !== undefined && acknowledgement !== undefined) {
        await this.#executionAuthority.releaseCurrent(
          transaction,
          claim.request,
          acknowledgement,
          now,
        );
      }
    });
  }

  async #recordFailure(
    claim: ClaimedTurn,
    started: boolean,
    failure: ExecutionFailure,
    acknowledgement: TurnExecutionLease | undefined,
  ): Promise<RunExecutionResult> {
    const now = safeDate(this.#clock);
    const shouldRetry = !started && failure.retryable && claim.attempt < this.#maxAttempts;
    const terminalEventId = this.#idGenerator();
    const terminalBody = {
      type: "turn.failed",
      payload: {
        code: failure.code,
        message: failure.safeMessage,
        retryable: failure.retryable,
      },
    } as const;
    let preparedProjection: PreparedTerminalTurnProjection | undefined;
    const initialEventSeq = Number(claim.request.nextEventSeq) - 1;
    const hasVisibleTurnPrefix =
      failure.lastEventSeq !== undefined && failure.lastEventSeq > initialEventSeq;
    if (!shouldRetry && started && hasVisibleTurnPrefix) {
      try {
        preparedProjection = await this.#terminalTurnProjectionSource?.prepare({
          tenantId: claim.request.tenantId,
          sessionId: claim.request.sessionId,
          turnId: claim.request.turnId,
          runId: claim.request.runId,
          agentId: "root",
          body: terminalBody,
          eventId: terminalEventId,
          occurredAt: now.toISOString(),
        });
      } catch {
        // Interrupted-prefix recovery is best effort and cannot control the
        // authoritative Run/Session terminal transaction.
      }
    }

    await this.#database.transaction().execute(async (transaction) => {
      const rows = await this.#lockLifecycleRows(transaction, claim);

      if (shouldRetry) {
        if (
          rows.runState !== "claimed" ||
          rows.turnState !== "queued" ||
          !["cold", "idle"].includes(rows.sessionState)
        ) {
          throw new RunExecutorInvariantError(
            "Only an unstarted Run can return to the Session mailbox",
          );
        }
        const attemptState = transitionRunAttempt(rows.runAttemptState, "failed");
        const attemptUpdate = await transaction
          .updateTable("run_attempts")
          .set({
            state: attemptState,
            failure_code: failure.code,
            failure_message: failure.safeMessage,
            failure_retryable: failure.retryable,
            settled_at: now,
            updated_at: now,
          })
          .where("tenant_id", "=", claim.request.tenantId)
          .where("run_id", "=", claim.request.runId)
          .where("id", "=", claim.request.attemptId)
          .where("state", "=", rows.runAttemptState)
          .executeTakeFirst();
        expectOne(attemptUpdate.numUpdatedRows, "failing a retryable run attempt");
        await transaction
          .insertInto("run_attempt_transitions")
          .values({
            id: this.#idGenerator(),
            tenant_id: claim.request.tenantId,
            run_id: claim.request.runId,
            attempt_id: claim.request.attemptId,
            from_state: rows.runAttemptState,
            to_state: attemptState,
            reason: "execution_retry_scheduled",
            occurred_at: now,
          })
          .executeTakeFirstOrThrow();
        const runUpdate = await transaction
          .updateTable("runs")
          .set({
            state: transitionRun(rows.runState, "queued"),
            available_at: now,
            stop_reason: null,
            failure_code: null,
            failure_message: null,
            failure_retryable: null,
            settled_at: null,
            row_version: sql<string>`${sql.ref("row_version")} + 1`,
            updated_at: now,
          })
          .where("tenant_id", "=", claim.request.tenantId)
          .where("id", "=", claim.request.runId)
          .where("current_attempt_id", "=", claim.request.attemptId)
          .where("state", "=", rows.runState)
          .where("row_version", "=", rows.runVersion)
          .executeTakeFirst();
        expectOne(runUpdate.numUpdatedRows, "requeueing a run");

        return;
      }

      const expectedTurnState = started ? "running" : "queued";
      if (rows.turnState !== expectedTurnState) {
        throw new RunExecutorInvariantError(
          "Turn lifecycle does not match the reported execution phase",
        );
      }

      if (started && this.#executionAuthority !== undefined && acknowledgement !== undefined) {
        if (this.#executionAuthority.assertCurrentOrExpired !== undefined) {
          await this.#executionAuthority.assertCurrentOrExpired(
            transaction,
            claim.request,
            acknowledgement,
            now,
          );
        } else {
          await this.#executionAuthority.assertCurrent(
            transaction,
            claim.request,
            acknowledgement,
            now,
          );
        }
      }
      await this.#storeEventBoundary(
        transaction,
        claim,
        failure.lastEventSeq ?? Number(claim.request.nextEventSeq) - 1,
        now,
      );
      const timedOut = /(?:^|_)timeout$/.test(failure.code) || failure.code === "pi_timeout";
      if (failure.code.startsWith("environment_")) {
        await transaction
          .insertInto("environment_validations")
          .values({
            id: this.#idGenerator(),
            tenant_id: claim.request.tenantId,
            project_id: claim.request.projectId,
            environment_version_id: claim.request.environment.environmentVersionId,
            run_id: claim.request.runId,
            attempt_id: claim.request.attemptId,
            status: "failed",
            report: null,
            failure_code: failure.code,
            validated_at: now,
          })
          .onConflict((conflict) =>
            conflict.columns(["environment_version_id", "run_id", "attempt_id"]).doNothing(),
          )
          .executeTakeFirst();
        await transaction
          .updateTable("environment_versions")
          .set({
            state: "failed",
            failure_code: failure.code,
            validated_at: null,
            updated_at: now,
          })
          .where("tenant_id", "=", claim.request.tenantId)
          .where("project_id", "=", claim.request.projectId)
          .where("id", "=", claim.request.environment.environmentVersionId)
          .where("recipe_sha256", "=", claim.request.environment.recipeSha256)
          .executeTakeFirstOrThrow();
      }
      await transitionCurrentRunAttempt(
        transaction,
        {
          tenantId: claim.request.tenantId,
          runId: claim.request.runId,
          attemptId: claim.request.attemptId,
        },
        {
          runState: timedOut ? "timed_out" : "failed",
          attemptState: timedOut ? "timed_out" : "failed",
          reason: timedOut ? "execution_timed_out" : "execution_failed",
          now,
          failure: {
            code: failure.code,
            message: failure.safeMessage,
            retryable: failure.retryable,
          },
          transitionId: this.#idGenerator(),
        },
      );

      const turnUpdate = await transaction
        .updateTable("turns")
        .set({
          state: transitionTurn(rows.turnState, "failed"),
          failure_code: failure.code,
          failure_message: failure.safeMessage,
          failure_retryable: failure.retryable,
          settled_at: now,
        })
        .where("tenant_id", "=", claim.request.tenantId)
        .where("id", "=", claim.request.turnId)
        .where("state", "=", rows.turnState)
        .executeTakeFirst();
      expectOne(turnUpdate.numUpdatedRows, "failing a turn");
      await commitTerminalTurnEvent(transaction, {
        tenantId: claim.request.tenantId,
        sessionId: claim.request.sessionId,
        turnId: claim.request.turnId,
        runId: claim.request.runId,
        agentId: "root",
        body: terminalBody,
        now,
        eventId: terminalEventId,
        ...(preparedProjection === undefined ? {} : { preparedProjection }),
      });

      if (started) {
        if (rows.sessionState !== "running") {
          throw new RunExecutorInvariantError("A started execution must own a running session");
        }
        const nextSessionState = failure.quarantineSession
          ? transitionSession(rows.sessionState, "failed")
          : transitionSession(rows.sessionState, "idle");
        const sessionUpdate = await transaction
          .updateTable("sessions")
          .set({
            state: nextSessionState,
            row_version: sql<string>`${sql.ref("row_version")} + 1`,
            updated_at: now,
            last_active_at: now,
          })
          .where("tenant_id", "=", claim.request.tenantId)
          .where("id", "=", claim.request.sessionId)
          .where("state", "=", rows.sessionState)
          .executeTakeFirst();
        expectOne(sessionUpdate.numUpdatedRows, "settling a failed session");
        if (this.#executionAuthority !== undefined && acknowledgement !== undefined) {
          await this.#executionAuthority.releaseCurrent(
            transaction,
            claim.request,
            acknowledgement,
            now,
          );
        }
      }
    });

    if (shouldRetry) {
      return {
        status: "retry_scheduled",
        runId: claim.request.runId,
        sessionId: claim.request.sessionId,
        turnId: claim.request.turnId,
        attempt: claim.attempt,
        failureCode: failure.code,
      };
    }
    return {
      status: "failed",
      runId: claim.request.runId,
      sessionId: claim.request.sessionId,
      turnId: claim.request.turnId,
      attempt: claim.attempt,
      phase: started ? "after_start" : "before_start",
      failureCode: failure.code,
    };
  }

  async #storeEventBoundary(
    transaction: Transaction<Database>,
    claim: ClaimedTurn,
    sequence: number,
    now: Date,
  ): Promise<void> {
    const minimum = Number(claim.request.nextEventSeq) - 1;
    if (!Number.isSafeInteger(sequence) || sequence < minimum) {
      throw new RunExecutorInvariantError("Run event boundary is invalid");
    }
    const updated = await transaction
      .updateTable("run_attempts")
      .set({ last_event_seq: sequence, updated_at: now })
      .where("tenant_id", "=", claim.request.tenantId)
      .where("run_id", "=", claim.request.runId)
      .where("id", "=", claim.request.attemptId)
      .where("last_event_seq", "<=", String(sequence))
      .executeTakeFirst();
    if (updated.numUpdatedRows === 1n) return;
    const existing = await transaction
      .selectFrom("run_attempts")
      .select("last_event_seq")
      .where("tenant_id", "=", claim.request.tenantId)
      .where("run_id", "=", claim.request.runId)
      .where("id", "=", claim.request.attemptId)
      .executeTakeFirst();
    if (existing === undefined || Number(existing.last_event_seq) < sequence) {
      throw new RunExecutorInvariantError("Run event boundary could not be advanced or confirmed");
    }
  }

  async #lockLifecycleRows(
    transaction: Transaction<Database>,
    claim: ClaimedTurn,
  ): Promise<LifecycleRows> {
    const row = await transaction
      .selectFrom("runs as run")
      .innerJoin("turns as turn", (join) =>
        join
          .onRef("turn.tenant_id", "=", "run.tenant_id")
          .onRef("turn.session_id", "=", "run.session_id")
          .onRef("turn.id", "=", "run.turn_id"),
      )
      .innerJoin("sessions as session_row", (join) =>
        join
          .onRef("session_row.tenant_id", "=", "run.tenant_id")
          .onRef("session_row.id", "=", "run.session_id"),
      )
      .innerJoin("run_attempts as run_attempt", (join) =>
        join
          .onRef("run_attempt.run_id", "=", "run.id")
          .onRef("run_attempt.id", "=", "run.current_attempt_id"),
      )
      .select([
        "turn.state as turnState",
        "session_row.state as sessionState",
        "run.state as runState",
        "run.failure_code as runFailureCode",
        "run.row_version as runVersion",
        "run.attempt_count as runAttemptCount",
        "run.current_attempt_id as currentAttemptId",
        "run_attempt.state as runAttemptState",
      ])
      .where("run.tenant_id", "=", claim.request.tenantId)
      .where("turn.id", "=", claim.request.turnId)
      .where("session_row.id", "=", claim.request.sessionId)
      .where("run.id", "=", claim.request.runId)
      .where("run_attempt.id", "=", claim.request.attemptId)
      .forUpdate(["turn", "session_row", "run", "run_attempt"])
      .executeTakeFirst();

    if (!row) {
      const authority = await transaction
        .selectFrom("runs")
        .select(["attempt_count as attemptCount", "current_attempt_id as attemptId"])
        .where("id", "=", claim.request.runId)
        .where("tenant_id", "=", claim.request.tenantId)
        .forUpdate()
        .executeTakeFirst();
      if (
        authority !== undefined &&
        (authority.attemptCount !== claim.attempt ||
          authority.attemptId !== claim.request.attemptId)
      ) {
        throw new RunExecutorStaleClaimError("Run attempt was superseded");
      }
      throw new RunExecutorInvariantError("Claimed Run lifecycle rows are missing");
    }
    if (Number(row.runVersion) < 1 || claim.attempt < 1) {
      throw new RunExecutorInvariantError("Claimed Run version is invalid");
    }
    if (row.runAttemptCount !== claim.attempt) {
      throw new RunExecutorStaleClaimError(
        `Run claim attempt ${claim.attempt} was superseded by attempt ${row.runAttemptCount}`,
      );
    }
    if (row.currentAttemptId !== claim.request.attemptId) {
      throw new RunExecutorStaleClaimError("Run attempt was superseded");
    }
    return row;
  }
}
