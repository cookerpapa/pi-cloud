import type { Database } from "@pi-cloud/database";
import {
  transitionSession,
  transitionTurn,
  type SessionState,
  type TurnState,
} from "@pi-cloud/domain";
import {
  parseCloudToolCapabilitySnapshot,
  parseEnvironmentRuntimeSnapshot,
  parseExecutionReference,
} from "@pi-cloud/protocol";
import type {
  AgentRevisionSnapshot,
  AgentRuntimeKind,
  CancelTurnCommandMessage,
  CloudToolCapabilitySnapshot,
  TurnBudgetSnapshot,
} from "@pi-cloud/protocol";
import type { EnvironmentRuntimeSnapshot, TraceContext } from "@pi-cloud/protocol";
import { operationalLog, virtualRunTraceCarrier, withSpan } from "@pi-cloud/observability";
import type { PiCloudMetrics } from "@pi-cloud/observability";
import { sql, type Kysely, type Transaction } from "kysely";
import { randomUUID } from "node:crypto";
import { transitionCurrentRun } from "./run-state.ts";
import {
  lockPiSessionWorkerOwnership,
  piSessionWorkerAvailable,
  type LockedPiSessionOwnership,
} from "./pi-session-worker-ownership.ts";
import { requestExecutionStreamSeal } from "./execution-stream-seal.ts";
import { confirmAgentExit } from "./quarantined-session-recovery.ts";
import { retryTransaction } from "@pi-cloud/database";
import type { ExecutionPublication } from "./accepted-fact.ts";
import { isDeepStrictEqual } from "node:util";
import { createExecutionPublication } from "./execution-publication.ts";
import { SessionLeaseCoordinatorError } from "./session-lease-coordinator.ts";

export type TurnExecutionRequest = {
  tenantId: string;
  projectId: string;
  workspaceId: string;
  sessionId: string;
  piSessionId: string;
  piSessionLane: string;
  runId: string;
  turnId: string;
  agent: AgentRevisionSnapshot;
  idempotencyKey: string;
  nextEventSeq: string;
  input: {
    kind: "prompt";
    prompt: string;
  };
  executionMode: import("@pi-cloud/protocol").ExecutionMode;
  sessionKind: import("@pi-cloud/database").SessionKind;
  workspaceSeedKind: import("@pi-cloud/database").WorkspaceSeedKind;
  computeSessionId?: string;
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

export type TurnExecutionReference = {
  executionReference: string;
};

export type TurnExecutionAdmission = TurnExecutionReference & {
  publication: ExecutionPublication;
};

export type RunClaimReference = Pick<TurnExecutionRequest, "runId" | "tenantId" | "piSessionId">;
export type RunClaimAdmission = Readonly<{
  /** Undefined admits a new family; an empty array admits none. */
  allowedFamilyKeys?: readonly string[];
  blockedFamilyKeys: readonly string[];
}>;

export type TurnExecutionLifecycle = {
  /** Positive local Agent Loop exit, independent of guest Tool cleanup. */
  executionExited(): void;
};

export type TurnExecutionResult = {
  stopReason: string;
  lastEventSeq?: number;
};

export interface TurnExecutionBackend {
  /** SQL-only admission, when the backend requires distributed execution authority. */
  admit(
    transaction: Transaction<Database>,
    request: TurnExecutionRequest,
    mark: (stage: string) => void,
    facts: ExecutionAdmissionFacts,
  ): Promise<TurnExecutionAdmission>;
  execute(
    request: TurnExecutionRequest,
    lifecycle: TurnExecutionLifecycle,
    admission: TurnExecutionAdmission,
  ): Promise<TurnExecutionResult>;
}

/** Facts produced under this transaction's Run/family locks, never a cache. */
export type ExecutionAdmissionFacts = Readonly<{
  physical: LockedPiSessionOwnership;
}>;

export interface TurnExecutionAuthority {
  assertCurrent(
    transaction: Transaction<Database>,
    request: TurnExecutionRequest,
    grant: TurnExecutionReference,
  ): Promise<void>;
  assertCurrentOrExpired(
    transaction: Transaction<Database>,
    request: TurnExecutionRequest,
    grant: TurnExecutionReference,
  ): Promise<void>;
  releaseCurrent(
    transaction: Transaction<Database>,
    request: TurnExecutionRequest,
    grant: TurnExecutionReference,
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

export type RunExecutionResult =
  | { status: "idle" }
  | {
      status: "cancellation_pending" | "cancelled";
      runId: string;
      sessionId: string;
      turnId: string;
    }
  | {
      status: "completed";
      runId: string;
      sessionId: string;
      turnId: string;
    }
  | {
      status: "failed";
      runId: string;
      sessionId: string;
      turnId: string;
      phase: "after_admission";
      failureCode: string;
    };

export type RunExecutorOptions = {
  database: Kysely<Database>;
  backend: TurnExecutionBackend;
  clock?: () => Date;
  workerId: string;
  idGenerator?: () => string;
  executionAuthority: TurnExecutionAuthority;
  metrics?: PiCloudMetrics;
  agentRuntimeKind?: AgentRuntimeKind;
};

type ClaimedTurn = {
  request: TurnExecutionRequest;
  queuedAt: Date;
  admission: TurnExecutionAdmission;
};

type LifecycleRows = {
  turnState: TurnState;
  sessionState: SessionState;
  runState: import("@pi-cloud/domain").RunState;
  runFailureCode: string | null;
  runVersion: string;
};

type ExecutionFailure = {
  code: string;
  safeMessage: string;
  retryable: boolean;
  quarantineSession: boolean;
  lastEventSeq?: number;
};

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
  readonly #workerId: string;
  readonly #idGenerator: () => string;
  readonly #executionAuthority: TurnExecutionAuthority;
  readonly #metrics: PiCloudMetrics | undefined;
  readonly #agentRuntimeKind: AgentRuntimeKind;

  constructor(options: RunExecutorOptions) {
    this.#database = options.database;
    this.#backend = options.backend;
    this.#clock = options.clock ?? (() => new Date());
    this.#workerId = options.workerId;
    this.#idGenerator = options.idGenerator ?? randomUUID;
    this.#executionAuthority = options.executionAuthority;
    this.#metrics = options.metrics;
    this.#agentRuntimeKind = options.agentRuntimeKind ?? "pi_sdk";
  }

  /**
   * Executes one durable Run selected by the PostgreSQL Worker queue. This component
   * owns transactional admission and lifecycle commits; it never chooses
   * between tenants, Sessions, or Runs.
   */
  async dispatchRun(runId: string, admission?: RunClaimAdmission): Promise<RunExecutionResult> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) {
      throw new TypeError("runId must be a UUID");
    }
    return this.#dispatch(runId.toLowerCase(), admission);
  }

  async dispatchNext(
    admission?: RunClaimAdmission,
    onClaimed?: (reference: RunClaimReference) => void,
  ): Promise<RunExecutionResult> {
    return this.#dispatch(undefined, admission, onClaimed);
  }

  async #dispatch(
    runId?: string,
    admission?: RunClaimAdmission,
    onClaimed?: (reference: RunClaimReference) => void,
  ): Promise<RunExecutionResult> {
    const claimStartedAt = performance.now();
    let claim: ClaimedTurn | undefined;
    try {
      claim = await this.#claimNext(runId, admission);
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
    onClaimed?.(claim.request);

    const observedAt = safeDate(this.#clock).valueOf();
    this.#metrics?.queueWait.observe(Math.max(0, observedAt - claim.queuedAt.valueOf()) / 1_000);
    this.#metrics?.activeRuns.inc();
    const executionStartedAt = performance.now();
    let agentExited = false;
    let completed = false;
    try {
      const result = await withSpan<RunExecutionResult>({
        serviceName: "pi-cloud-control-plane",
        name: "run.dispatch",
        ...(claim.request.traceContext === undefined ? {} : { parent: claim.request.traceContext }),
        attributes: {
          "pi_cloud.run.id": claim.request.runId,
          "pi_cloud.session.id": claim.request.sessionId,
        },
        run: async () => {
          const acknowledgement = claim.admission;
          const lifecycle: TurnExecutionLifecycle = {
            executionExited: () => {
              agentExited = true;
            },
          };

          let executionResult: TurnExecutionResult;
          try {
            executionResult = await this.#backend.execute(
              claim.request,
              lifecycle,
              claim.admission,
            );
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
            const externallySettled = await this.#observeCancellation(claim);
            if (externallySettled !== undefined) return externallySettled;
            if (error instanceof TurnExecutionCancelledError && error.reason === "user_request") {
              throw new RunExecutorInvariantError(
                "Cancellation confirmation arrived before its durable lifecycle",
              );
            }
            return this.#recordFailure(claim, normalizeFailure(error), acknowledgement);
          }

          const status = await this.#complete(claim, executionResult, acknowledgement);
          completed = status === "completed";
          return {
            status,
            runId: claim.request.runId,
            sessionId: claim.request.sessionId,
            turnId: claim.request.turnId,
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
      // Normal completion already leaves the Session idle. Failure/cancellation
      // may race the seal, so retain positive exit evidence for either order.
      if (agentExited && !completed) await confirmAgentExit(this.#database, claim.request);
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
          phase: "after_admission",
          failureCode: rows.runFailureCode ?? "cancellation_failed",
        };
      }
      return undefined;
    });
  }

  #familyAdmission(alias: string, admission?: RunClaimAdmission) {
    if (!admission) return sql<boolean>`true`;
    const key = sql<string>`concat(${sql.ref(`${alias}.tenant_id`)}::text, ':', ${sql.ref(`${alias}.pi_session_id`)})`;
    return sql<boolean>`(${admission.allowedFamilyKeys === undefined ? sql`true` : sql`${key} = any(${[...admission.allowedFamilyKeys]}::text[])`})
      and not (${key} = any(${[...admission.blockedFamilyKeys]}::text[]))`;
  }

  #taskOwnerAvailable(runAlias: string) {
    // Delegated work belongs to a live parent task, not merely to historical
    // Session ancestry. A departed parent's queued child cannot start a new owner.
    return sql<boolean>`not exists(select 1 from subagent_executions e
      where e.child_run_id=${sql.ref(`${runAlias}.id`)} and not exists(
        select 1 from active_execution_scopes parent where parent.run_id=e.parent_run_id
          and parent.accepting_effects and parent.valid_until>clock_timestamp()
      ))`;
  }

  async #claimNext(
    runId?: string,
    admission?: RunClaimAdmission,
  ): Promise<ClaimedTurn | undefined> {
    const startedAtMs = Date.now();
    const started = performance.now();
    let previous = started;
    const stages: Array<[string, number]> = [];
    const mark = (stage: string) => {
      const now = performance.now();
      stages.push([stage, (now - previous) / 1_000]);
      previous = now;
    };
    let committedCandidate: ClaimedTurn | undefined;
    const admitTransaction = async (transaction: Transaction<Database>) => {
      committedCandidate = undefined;
      stages.length = 0;
      mark("transaction_begin");
      const candidate = transaction
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
        .selectAll("candidate")
        .$if(runId !== undefined, (q) => q.where("candidate.id", "=", runId!))
        .where("candidate.available_at", "<=", sql<Date>`clock_timestamp()`)
        // These code-owned states are also the partial ready-index predicate.
        // Parameters prevent a generic prepared plan from proving that match.
        .where(sql<boolean>`candidate.state = 'queued' and candidate.ready_at is not null`)
        .where("candidate_session.state", "in", ["cold", "idle"])
        .where(this.#familyAdmission("candidate_session", admission))
        .where(this.#taskOwnerAvailable("candidate"))
        .where("candidate_policy.enabled", "=", true)
        .where("candidate_agent.runtime_kind", "=", this.#agentRuntimeKind)
        .where(
          piSessionWorkerAvailable(
            sql.ref("candidate_session.tenant_id"),
            sql.ref("candidate_session.pi_session_id"),
            this.#workerId,
          ),
        )
        .orderBy("candidate.available_at", "asc")
        .orderBy("candidate.queued_at", "asc")
        .orderBy("candidate.id", "asc")
        .limit(1)
        .forUpdate("candidate")
        .skipLocked();
      // Materialize the locked candidate once. The outer query only loads its
      // context; it does not plan/evaluate a second copy of queue eligibility.
      const context = await transaction
        .with(
          (cte) => cte("claim_candidate").materialized(),
          () => candidate,
        )
        .selectFrom("claim_candidate as run")
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
        .select([
          "run.tenant_id as tenantId",
          "run.agent_revision_id as agentRevisionId",
          "run.environment_version_id as environmentVersionId",
          "run.project_id as environmentProjectId",
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
          "workspace_row.seed_kind as workspaceSeedKind",
          "session_row.execution_mode as executionMode",
          "session_row.project_id as projectId",
          "session_row.workspace_id as workspaceId",
          "session_row.next_event_seq as nextEventSeq",
          "run.id as runId",
          "run.trace_id as traceId",
          "run.tool_capability_snapshot as toolCapabilitySnapshot",
          "run.agent_system_prompt as agentSystemPrompt",
          "run.working_directory as workingDirectory",
          "run.compute_session_id as computeSessionId",
          "run.sandbox_profile_key as sandboxProfileKey",
          "run.queued_at as runQueuedAt",
          "run.state as runState",
          "run.row_version as runVersion",
        ])
        .where("workspace_row.deleted_at", "is", null)
        .whereRef("session_row.workspace_id", "=", "run.workspace_id")
        .whereRef("session_row.project_id", "=", "run.project_id")
        .whereRef("workspace_row.project_id", "=", "run.project_id")
        .whereRef("session_row.agent_revision_id", "=", "run.agent_revision_id")
        .where("turn.state", "=", "queued")
        .executeTakeFirst();

      mark("candidate_context");
      if (!context) return undefined;

      // Fixed-ID configuration lookup stays in the claim transaction. Keeping
      // it separate avoids planning one large join/anti-join graph per Run.
      const configuration = await transaction
        .selectFrom("agent_revisions as agent_revision")
        .innerJoin(
          "agent_definitions as agent_definition",
          "agent_definition.id",
          "agent_revision.definition_id",
        )
        .innerJoin("environment_versions as environment", (join) =>
          join
            .on("environment.id", "=", context.environmentVersionId)
            .on("environment.tenant_id", "=", context.tenantId)
            .on("environment.project_id", "=", context.environmentProjectId),
        )
        .innerJoin("tenant_runtime_policies as policy", (join) =>
          join.on("policy.tenant_id", "=", context.tenantId),
        )
        .select([
          "agent_definition.key as agentDefinitionKey",
          "agent_revision.runtime_kind as agentRuntimeKind",
          "agent_revision.runtime_version as agentRuntimeVersion",
          "agent_revision.harness_version as agentHarnessVersion",
          "agent_revision.session_storage_kind as agentSessionStorageKind",
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
        .where("agent_revision.id", "=", context.agentRevisionId)
        .where("agent_revision.runtime_kind", "=", this.#agentRuntimeKind)
        .where("policy.enabled", "=", true)
        .executeTakeFirst();
      mark("configuration");
      if (!configuration) return undefined;
      const row = { ...context, ...configuration };

      const physical = await lockPiSessionWorkerOwnership(
        transaction,
        row.tenantId,
        row.piSessionId,
      );

      if (row.inputKind !== "prompt" || row.inputText === null) {
        throw new RunExecutorInvariantError(
          "The v1 turn dispatcher only accepts durable prompt turns",
        );
      }
      safeMailboxPosition(row.mailboxPosition);

      const maximumToolCalls = safeNonNegativeInteger(row.maximumToolCalls, "tool-call budget");
      // Each newly admitted Run starts with its frozen budget. Recovery does
      // not replay an admitted Run; the Runner decrements this budget locally.
      const remainingToolCalls = maximumToolCalls;
      const toolCapabilities = parseCloudToolCapabilitySnapshot(row.toolCapabilitySnapshot);

      mark("ownership");
      const request: TurnExecutionRequest = {
        tenantId: row.tenantId,
        projectId: row.projectId,
        workspaceId: row.workspaceId,
        sessionId: row.sessionId,
        piSessionId: row.piSessionId,
        piSessionLane: row.piSessionLane,
        runId: row.runId,
        turnId: row.turnId,
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
        input: { kind: "prompt" as const, prompt: row.inputText },
        executionMode: row.executionMode,
        sessionKind: row.sessionKind,
        workspaceSeedKind: row.workspaceSeedKind,
        ...(row.computeSessionId === null ? {} : { computeSessionId: row.computeSessionId }),
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
          row.runId.replaceAll("-", "").slice(0, 16),
        ),
      };
      const claim: ClaimedTurn = {
        request,
        queuedAt: new Date(row.runQueuedAt),
        admission: await this.#backend.admit(transaction, request, mark, { physical }),
      };
      await this.#startAdmittedRun(transaction, claim, row.runVersion);
      mark("admitted_running");
      committedCandidate = claim;
      return claim;
    };
    let result: ClaimedTurn | undefined;
    try {
      result = await retryTransaction(this.#database, admitTransaction);
    } catch (error) {
      // Different cold Lanes may select candidates before the family lock elects
      // an owner. A rolled-back ownership loss is ordinary queue contention.
      if (
        !committedCandidate &&
        error instanceof SessionLeaseCoordinatorError &&
        error.code === "session_lease_conflict"
      )
        return undefined;
      // Only the exact admission whose COMMIT reply was lost may continue.
      // Never retry a transport error as another execution.
      if (!committedCandidate?.admission) throw error;
      const candidate = committedCandidate;
      const recorded = await this.#database
        .selectFrom("runs as a")
        .select(["a.output_publication", "a.sandbox_id"])
        .where("a.id", "=", candidate.request.runId)
        .where("a.tenant_id", "=", candidate.request.tenantId)
        .where("a.state", "=", "running")
        .executeTakeFirst();
      if (
        recorded?.sandbox_id !== this.#workerId ||
        !isDeepStrictEqual(recorded.output_publication, candidate.admission!.publication)
      )
        throw error;
      // The exact committed admission already contains running state. Do not
      // admit another execution when the COMMIT response was lost.
      result = candidate;
    }
    mark("finish");
    // Idle scans and rolled-back claims do not contaminate successful admission
    // timings. No SQL, lock, parameter or durable transition is added here.
    if (result) {
      for (const [stage, seconds] of stages)
        this.#metrics?.runClaimStageDuration.observe({ stage }, seconds);
      try {
        operationalLog({
          service: "pi-cloud-worker",
          level: "info",
          event: "run.claim.timing",
          attributes: {
            runId: result.request.runId,
            startedAtMs,
            durationMs: performance.now() - started,
            stages: Object.fromEntries(stages.map(([stage, seconds]) => [stage, seconds * 1000])),
          },
        });
      } catch {
        // Admission is already committed; a logging failure cannot requeue it.
      }
    }
    return result;
  }

  /** Admission owns these rows; finish with conditional writes, not re-reads. */
  async #startAdmittedRun(
    transaction: Transaction<Database>,
    claim: ClaimedTurn,
    runVersion: string,
  ): Promise<void> {
    const now = safeDate(this.#clock),
      r = claim.request;
    const ref = parseExecutionReference(claim.admission.executionReference);
    const expected = createExecutionPublication({
      tenantId: r.tenantId,
      runId: r.runId,
      sessionId: r.sessionId,
      turnId: r.turnId,
      executionReference: claim.admission.executionReference,
      nextEventSeq: Number(r.nextEventSeq),
      piSession: { id: r.piSessionId, lane: r.piSessionLane, writerId: ref.leaseId },
    });
    if (!isDeepStrictEqual(claim.admission.publication, expected))
      throw new RunExecutorInvariantError("Admission publication does not match its Run");
    const result = await sql<{
      turns: number;
      sessions: number;
      runs: number;
      transitions: number;
    }>`with "started_turn" as (
      update turns set state='running',started_at=${now}
        where tenant_id=${r.tenantId}::uuid and id=${r.turnId}::uuid and state='queued'
        returning id
    ), "started_session" as (
      update sessions set state='running',row_version=row_version+1,
        updated_at=${now},last_active_at=${now}
        where tenant_id=${r.tenantId}::uuid and id=${r.sessionId}::uuid and state in ('cold','idle')
        returning id
    ), started_run as (
      update runs set state='running',ready_at=null,started_at=${now},
        updated_at=${now},last_heartbeat_at=${now},row_version=row_version+1,
        sandbox_id=${this.#workerId}::uuid,lease_id=${ref.leaseId}::uuid,
        fencing_token=${ref.fencingToken},last_event_seq=${Math.max(0, Number(r.nextEventSeq) - 1)},
        output_publication=${JSON.stringify(claim.admission.publication)}::jsonb,native_output_drained=false
        where tenant_id=${r.tenantId}::uuid and id=${r.runId}::uuid
          and state='queued' and ready_at is not null and lease_id is null and row_version=${runVersion}::bigint
          and exists(select 1 from session_leases l where l.lease_id=${ref.leaseId}::uuid
            and l.tenant_id=${r.tenantId}::uuid and l.pi_session_id=${r.piSessionId}
            and l.sandbox_id=${this.#workerId}::uuid and l.fencing_token=${ref.fencingToken}
            and l.released_at is null and l.valid_until>clock_timestamp()
            and l.writer_failed_at is null and l.writer_sealed_at is null)
        returning id
    ), recorded_transition as (
      insert into run_transitions(id,tenant_id,run_id,from_state,to_state,reason,occurred_at)
        select ${this.#idGenerator()}::uuid,${r.tenantId}::uuid,id,
          'queued','running','execution_admitted',${now} from started_run
        returning id
    )
    select (select count(*)::int from "started_turn") as turns,
      (select count(*)::int from "started_session") as sessions,
      (select count(*)::int from started_run) as runs,
      (select count(*)::int from recorded_transition) as transitions`.execute(transaction);
    const counts = result.rows[0];
    if (!counts || Object.values(counts).some((count) => count !== 1))
      throw new RunExecutorInvariantError("Execution admission did not start exactly one task");
  }

  async #complete(
    claim: ClaimedTurn,
    result: TurnExecutionResult,
    acknowledgement: TurnExecutionReference,
  ): Promise<"completed" | "cancelled" | "cancellation_pending"> {
    const now = safeDate(this.#clock);
    const terminalEventId = this.#idGenerator();
    const terminalBody = {
      type: "turn.completed",
      payload: {
        stopReason: result.stopReason,
      },
    } as const;
    return retryTransaction(this.#database, async (transaction) => {
      const rows = await this.#lockLifecycleRows(transaction, claim);
      // Cancellation may win after admission but before the local Runner exists.
      // Its control request owns settlement; don't overwrite it with success.
      if (rows.runState === "cancel_requested" && rows.turnState === "cancelling")
        return "cancellation_pending";
      if (rows.runState === "cancelled" && rows.turnState === "cancelled") return "cancelled";
      if (
        rows.runState !== "running" ||
        rows.turnState !== "running" ||
        rows.sessionState !== "running"
      ) {
        throw new RunExecutorInvariantError("Only a running Run can complete");
      }

      await this.#executionAuthority.assertCurrent(transaction, claim.request, acknowledgement);
      await this.#storeEventBoundary(
        transaction,
        claim,
        result.lastEventSeq ?? Number(claim.request.nextEventSeq) - 1,
        now,
      );

      await transitionCurrentRun(
        transaction,
        {
          tenantId: claim.request.tenantId,
          runId: claim.request.runId,
        },
        {
          runState: "completed",
          reason: "execution_completed",
          now,
          stopReason: result.stopReason,
          transitionId: this.#idGenerator(),
        },
      );

      const turnUpdate = transaction
        .updateTable("turns")
        .set({
          state: transitionTurn(rows.turnState, "completed"),
          stop_reason: result.stopReason,
          settled_at: now,
        })
        .where("tenant_id", "=", claim.request.tenantId)
        .where("id", "=", claim.request.turnId)
        .where("state", "=", rows.turnState)
        .returning("id");

      const sessionUpdate = transaction
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
        .returning("id");
      const updated = await transaction
        .with("completed_turn", () => turnUpdate)
        .with("settled_session", () => sessionUpdate)
        .selectNoFrom([
          sql<number>`(select count(*)::int from completed_turn)`.as("turns"),
          sql<number>`(select count(*)::int from settled_session)`.as("sessions"),
        ])
        .executeTakeFirstOrThrow();
      expectOne(BigInt(updated.turns), "completing a turn");
      expectOne(BigInt(updated.sessions), "settling a session");
      await requestExecutionStreamSeal(transaction, {
        tenantId: claim.request.tenantId,
        sessionId: claim.request.sessionId,
        turnId: claim.request.turnId,
        runId: claim.request.runId,
        agentId: "root",
        body: terminalBody,
        now,
        eventId: terminalEventId,
      });
      await this.#executionAuthority.releaseCurrent(
        transaction,
        claim.request,
        acknowledgement,
        now,
      );
      return "completed";
    });
  }

  async #recordFailure(
    claim: ClaimedTurn,
    failure: ExecutionFailure,
    acknowledgement: TurnExecutionReference,
  ): Promise<RunExecutionResult> {
    const now = safeDate(this.#clock);
    const terminalEventId = this.#idGenerator();
    const terminalBody = {
      type: "turn.failed",
      payload: {
        code: failure.code,
        message: failure.safeMessage,
        retryable: failure.retryable,
      },
    } as const;

    await retryTransaction(this.#database, async (transaction) => {
      const rows = await this.#lockLifecycleRows(transaction, claim);

      if (rows.turnState !== "running") {
        throw new RunExecutorInvariantError(
          "Turn lifecycle does not match the reported execution phase",
        );
      }

      await this.#executionAuthority.assertCurrentOrExpired(
        transaction,
        claim.request,
        acknowledgement,
      );
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
            status: "failed",
            report: null,
            failure_code: failure.code,
            validated_at: now,
          })
          .onConflict((conflict) =>
            conflict.columns(["environment_version_id", "run_id"]).doNothing(),
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
      await transitionCurrentRun(
        transaction,
        {
          tenantId: claim.request.tenantId,
          runId: claim.request.runId,
        },
        {
          runState: timedOut ? "timed_out" : "failed",
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
      await requestExecutionStreamSeal(transaction, {
        tenantId: claim.request.tenantId,
        sessionId: claim.request.sessionId,
        turnId: claim.request.turnId,
        runId: claim.request.runId,
        agentId: "root",
        body: terminalBody,
        now,
        eventId: terminalEventId,
      });

      {
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
      }
      await this.#executionAuthority.releaseCurrent(
        transaction,
        claim.request,
        acknowledgement,
        now,
      );
    });

    return {
      status: "failed",
      runId: claim.request.runId,
      sessionId: claim.request.sessionId,
      turnId: claim.request.turnId,
      phase: "after_admission",
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
      .updateTable("runs")
      .set({ last_event_seq: sequence, updated_at: now })
      .where("tenant_id", "=", claim.request.tenantId)
      .where("id", "=", claim.request.runId)
      .where("last_event_seq", "<=", String(sequence))
      .executeTakeFirst();
    if (updated.numUpdatedRows === 1n) return;
    const existing = await transaction
      .selectFrom("runs")
      .select("last_event_seq")
      .where("tenant_id", "=", claim.request.tenantId)
      .where("id", "=", claim.request.runId)
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
      .select([
        "turn.state as turnState",
        "session_row.state as sessionState",
        "run.state as runState",
        "run.failure_code as runFailureCode",
        "run.row_version as runVersion",
      ])
      .where("run.tenant_id", "=", claim.request.tenantId)
      .where("turn.id", "=", claim.request.turnId)
      .where("session_row.id", "=", claim.request.sessionId)
      .where("run.id", "=", claim.request.runId)
      .forNoKeyUpdate(["turn", "session_row", "run"])
      .executeTakeFirst();

    if (!row) {
      throw new RunExecutorInvariantError("Claimed Run lifecycle rows are missing");
    }
    return row;
  }
}
