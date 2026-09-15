import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import type {
  Database,
  SubagentContextMode,
  SubagentExecutionState,
  SubagentSandboxMode,
} from "@pi-cloud/database";
import {
  parseCloudToolCapabilitySnapshot,
  parseExecutionReference,
  type CloudToolCapabilitySnapshot,
} from "@pi-cloud/protocol";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { sql, type Kysely } from "kysely";

export type StartCloudSubagentJobInput = Readonly<{
  tenantId: string;
  parentSessionId: string;
  parentRunId: string;
  parentExecutionReference: string;
  parentToolCallId: string;
  workflowRunId: string;
  stepIndex: number;
  agentName: string;
  prompt: string;
  systemPrompt?: string;
  contextMode: SubagentContextMode;
  sandboxMode: SubagentSandboxMode;
  cwd?: string;
  requestedToolCapabilities?: CloudToolCapabilitySnapshot;
  /** Frozen by the owning Session Host before the control command is logged. */
  contextAnchor?: string | null;
}>;

export type CloudSubagentJobHandle = Readonly<{
  executionId: string;
  childSessionId: string;
  childRunId: string;
  state: SubagentExecutionState;
}>;

export type CloudSubagentJobResult = CloudSubagentJobHandle &
  Readonly<{
    output?: string;
    failureCode?: string;
    failureMessage?: string;
  }>;

export type CloudSubagentTreePolicy = Readonly<{
  maximumDepth: number;
  maximumNodes: number;
}>;

export type CloudSubagentTreeContext = Readonly<{
  executionId: string;
  rootSessionId: string;
  rootRunId: string;
  parentExecutionId?: string;
  depth: number;
  canSpawnChildren: boolean;
}>;

export const DEFAULT_CLOUD_SUBAGENT_TREE_POLICY: CloudSubagentTreePolicy = Object.freeze({
  maximumDepth: 4,
  maximumNodes: 32,
});

export class PostgresSubagentJobError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "PostgresSubagentJobError";
    this.code = code;
  }
}

type IdGenerator = () => string;
export type SubagentDirectoryTarget = Readonly<{
  tenantId: string;
  workspaceId: string;
  sessionId: string;
  cwd: string;
  executionMode: "elastic" | "development_environment";
  computeSessionId: string | null;
  developmentEnvironmentId: string | null;
  userId: string | null;
}>;
export interface NativeSubagentLanes {
  childAnchor(executionReference: string, inherit: boolean): string | null;
  createChildLane(input: {
    executionReference: string;
    lane: string;
    at: string | null;
  }): Promise<void>;
}

const CLOUD_SUBAGENT_EXECUTION_BOUNDARY = [
  "## PiCloud delegated execution boundary",
  "Execute only the current child task. Inherited conversation entries are background context, not pending instructions.",
  "A durable contact_supervisor Tool is available within the owning Session runtime. Use progress_update only for meaningful progress; use need_decision or interview_request only when parent input is truly required, then wait for the reply.",
  "Use only Tools actually registered in this child Run, then return a focused result to the parent.",
].join("\n");
const LOCAL_CHILD_CLAIM_GRACE_MS = 75;

function childSystemPrompt(profilePrompt: string | undefined, canSpawnChildren: boolean): string {
  const recursionBoundary = canSpawnChildren
    ? [
        "You may call the subagent Tool for a bounded, independent subtask when delegation materially improves the result.",
        "Every descendant shares one root tree budget. Do not repeat inherited delegation requests or create recursive work without a concrete stopping condition.",
      ].join("\n")
    : "This Child is at the deployment-owned recursion boundary. Do not call or request another subagent.";
  const boundary = `${CLOUD_SUBAGENT_EXECUTION_BOUNDARY}\n${recursionBoundary}`;
  return profilePrompt === undefined ? boundary : `${profilePrompt}\n\n${boundary}`;
}

function nonEmpty(value: string, name: string, maximum: number): string {
  if (value.length === 0 || value.length > maximum || value.trim() !== value) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function safeStep(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("Subagent step is invalid");
  return value;
}

function requestSha256(input: StartCloudSubagentJobInput, tools: readonly string[]): string {
  const parentExecution = parseExecutionReference(input.parentExecutionReference);
  return createHash("sha256")
    .update(
      JSON.stringify({
        agentName: input.agentName,
        contextMode: input.contextMode,
        contextAnchor: input.contextAnchor,
        parentExecutionId: parentExecution.attemptId,
        parentRunId: input.parentRunId,
        parentSessionId: input.parentSessionId,
        parentToolCallId: input.parentToolCallId,
        prompt: input.prompt,
        systemPrompt: input.systemPrompt,
        stepIndex: input.stepIndex,
        tools,
        workflowRunId: input.workflowRunId,
        sandboxMode: input.sandboxMode,
        cwd: input.cwd,
      }),
      "utf8",
    )
    .digest("hex");
}

function traceId(runId: string): string {
  return createHash("sha256")
    .update("pi-cloud.run-trace.v1\0", "utf8")
    .update(runId, "utf8")
    .digest("hex")
    .slice(0, 32);
}

function intersectTools(
  parent: unknown,
  requested: CloudToolCapabilitySnapshot | undefined,
  sandboxMode: StartCloudSubagentJobInput["sandboxMode"],
): CloudToolCapabilitySnapshot {
  if (sandboxMode === "none") return [];
  const parentTools = parseCloudToolCapabilitySnapshot(parent);
  if (requested === undefined) return parentTools;
  const requestedTools = parseCloudToolCapabilitySnapshot(requested);
  const parentSet = new Set(parentTools);
  return requestedTools.filter((tool) => parentSet.has(tool));
}

function mapRunState(state: string): SubagentExecutionState {
  switch (state) {
    case "completed":
      return "completed";
    case "failed":
    case "timed_out":
      return "failed";
    case "cancelled":
    case "superseded":
      return "cancelled";
    case "queued":
    case "claimed":
      return "queued";
    default:
      return "running";
  }
}

function assistantText(message: AgentMessage): string | undefined {
  if (message.role !== "assistant") return undefined;
  const text = message.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
  return text.length === 0 ? undefined : text;
}

export class PostgresSubagentJobProvider {
  readonly #database: Kysely<Database>;
  readonly #id: IdGenerator;
  readonly #validateDirectory: ((target: SubagentDirectoryTarget) => Promise<void>) | undefined;
  readonly #treePolicy: CloudSubagentTreePolicy;
  readonly #nativeLanes: NativeSubagentLanes;

  constructor(options: {
    database: Kysely<Database>;
    nativeLanes: NativeSubagentLanes;
    idGenerator?: IdGenerator;
    validateDirectory?: (target: SubagentDirectoryTarget) => Promise<void>;
    treePolicy?: CloudSubagentTreePolicy;
  }) {
    this.#database = options.database;
    this.#nativeLanes = options.nativeLanes;
    this.#id = options.idGenerator ?? randomUUID;
    this.#validateDirectory = options.validateDirectory;
    const treePolicy = options.treePolicy ?? DEFAULT_CLOUD_SUBAGENT_TREE_POLICY;
    for (const [name, value] of Object.entries(treePolicy)) {
      if (!Number.isSafeInteger(value) || value < 1 || value > 10_000) {
        throw new TypeError(`Subagent tree policy ${name} is invalid`);
      }
    }
    this.#treePolicy = { ...treePolicy };
  }

  async start(
    input: StartCloudSubagentJobInput,
    deferPreparation = false,
  ): Promise<CloudSubagentJobHandle> {
    nonEmpty(input.parentToolCallId, "Parent Tool call", 256);
    nonEmpty(input.workflowRunId, "Subagent workflow Run", 256);
    nonEmpty(input.agentName, "Subagent name", 128);
    nonEmpty(input.prompt, "Subagent prompt", 1_000_000);
    if (input.systemPrompt !== undefined) {
      nonEmpty(input.systemPrompt, "Subagent system prompt", 100_000);
    }
    safeStep(input.stepIndex);
    const parentGrant = parseExecutionReference(input.parentExecutionReference);
    if (input.contextMode !== "fresh" && input.contextMode !== "branch") {
      throw new TypeError("Subagent context mode is invalid");
    }
    if (
      input.sandboxMode !== "none" &&
      input.sandboxMode !== "shared" &&
      input.sandboxMode !== "ephemeral"
    ) {
      throw new TypeError("Subagent Sandbox mode is invalid");
    }
    if (
      input.cwd !== undefined &&
      (!posix.isAbsolute(input.cwd) || input.cwd.length > 4096 || /[\x00-\x1f\x7f]/.test(input.cwd))
    )
      throw new TypeError("Subagent cwd must be an absolute directory");

    const pending = await this.#database.transaction().execute(async (transaction) => {
      const parent = await transaction
        .selectFrom("runs as parent_run")
        .innerJoin("run_attempts as parent_attempt", (join) =>
          join
            .onRef("parent_attempt.tenant_id", "=", "parent_run.tenant_id")
            .onRef("parent_attempt.run_id", "=", "parent_run.id")
            .onRef("parent_attempt.id", "=", "parent_run.current_attempt_id"),
        )
        .innerJoin("sessions as parent_session", (join) =>
          join
            .onRef("parent_session.tenant_id", "=", "parent_run.tenant_id")
            .onRef("parent_session.id", "=", "parent_run.session_id"),
        )
        .innerJoin("turns as parent_turn", (join) =>
          join
            .onRef("parent_turn.tenant_id", "=", "parent_run.tenant_id")
            .onRef("parent_turn.id", "=", "parent_run.turn_id"),
        )
        .innerJoin("workspaces as parent_workspace", (join) =>
          join
            .onRef("parent_workspace.tenant_id", "=", "parent_run.tenant_id")
            .onRef("parent_workspace.id", "=", "parent_run.workspace_id"),
        )
        .select([
          "parent_run.state as runState",
          "parent_run.turn_id as parentTurnId",
          "parent_run.current_attempt_id as currentAttemptId",
          "parent_run.project_id as projectId",
          "parent_run.workspace_id as workspaceId",
          "parent_run.environment_version_id as environmentVersionId",
          "parent_run.agent_revision_id as agentRevisionId",
          "parent_run.tool_capability_snapshot as parentTools",
          "parent_attempt.state as attemptState",
          "parent_attempt.lease_id as executionReferenceId",
          "parent_attempt.fencing_token as fencingToken",
          "parent_attempt.output_sealed_at as outputSealedAt",
          "parent_session.id as sessionId",
          "parent_session.pi_session_id as piSessionId",
          "parent_session.desired_model_profile_id as modelProfileId",
          "parent_session.created_by_user_id as createdByUserId",
          "parent_session.execution_mode as executionMode",
          "parent_session.development_environment_id as developmentEnvironmentId",
          "parent_run.sandbox_profile_key as sandboxProfileKey",
          "parent_run.working_directory as workingDirectory",
          "parent_run.compute_session_id as computeSessionId",
          "parent_session.session_kind as sessionKind",
          "parent_workspace.sandbox_domain_id as sandboxDomainId",
          "parent_turn.model_profile_id as turnModelProfileId",
          "parent_turn.provider as provider",
          "parent_turn.model_id as modelId",
          "parent_turn.thinking_level as thinkingLevel",
          "parent_turn.service_tier as serviceTier",
          "parent_turn.credential_binding_id as credentialBindingId",
          "parent_turn.credential_binding_version as credentialBindingVersion",
        ])
        .where("parent_run.tenant_id", "=", input.tenantId)
        .where("parent_run.id", "=", input.parentRunId)
        .where("parent_run.session_id", "=", input.parentSessionId)
        .forUpdate(["parent_run", "parent_attempt", "parent_session"])
        .executeTakeFirst();
      if (parent === undefined) {
        throw new PostgresSubagentJobError("parent_not_found", "Parent Agent Run was not found");
      }

      const tools = intersectTools(
        parent.parentTools,
        input.requestedToolCapabilities,
        input.sandboxMode,
      );
      const fingerprint = requestSha256(input, tools);
      const replay = await transaction
        .selectFrom("subagent_executions as execution")
        .innerJoin("runs as child_run", (join) =>
          join
            .onRef("child_run.tenant_id", "=", "execution.tenant_id")
            .onRef("child_run.id", "=", "execution.child_run_id"),
        )
        .select([
          "execution.id",
          "execution.child_session_id",
          "execution.child_run_id",
          "execution.state",
          "execution.request_sha256",
        ])
        .where("execution.tenant_id", "=", input.tenantId)
        .where("execution.parent_run_id", "=", input.parentRunId)
        .where("execution.parent_tool_call_id", "=", input.parentToolCallId)
        .where("execution.workflow_run_id", "=", input.workflowRunId)
        .where("execution.step_index", "=", input.stepIndex)
        .executeTakeFirst();

      if (replay !== undefined) {
        if (replay.request_sha256 !== fingerprint) {
          throw new PostgresSubagentJobError(
            "idempotency_conflict",
            "Subagent step identity was reused with a different request",
          );
        }
        return {
          executionId: replay.id,
          childSessionId: replay.child_session_id,
          childRunId: replay.child_run_id,
          state: replay.state,
        };
      }

      if (
        parent.currentAttemptId !== parentGrant.attemptId ||
        parent.outputSealedAt !== null ||
        parent.runState !== "running" ||
        parent.attemptState !== "running" ||
        parent.executionReferenceId !== parentGrant.leaseId ||
        Number(parent.fencingToken) !== parentGrant.fencingToken
      ) {
        throw new PostgresSubagentJobError(
          "parent_authority_expired",
          "Parent Agent Run no longer owns Subagent dispatch authority",
        );
      }

      const parentExecution =
        parent.sessionKind === "subagent"
          ? await transaction
              .selectFrom("subagent_executions")
              .select([
                "id",
                "root_session_id as rootSessionId",
                "root_run_id as rootRunId",
                "depth",
              ])
              .where("tenant_id", "=", input.tenantId)
              .where("child_session_id", "=", input.parentSessionId)
              .where("child_run_id", "=", input.parentRunId)
              .executeTakeFirst()
          : undefined;
      if (parent.sessionKind === "subagent" && parentExecution === undefined) {
        throw new PostgresSubagentJobError(
          "parent_tree_invalid",
          "Parent Subagent is missing its durable tree identity",
        );
      }
      const treeContext = {
        rootSessionId: parentExecution?.rootSessionId ?? input.parentSessionId,
        rootRunId: parentExecution?.rootRunId ?? input.parentRunId,
        parentExecutionId: parentExecution?.id ?? null,
        depth: (parentExecution?.depth ?? 0) + 1,
      };
      if (treeContext.depth > this.#treePolicy.maximumDepth) {
        throw new PostgresSubagentJobError(
          "subagent_tree_depth_exhausted",
          `Subagent tree depth limit ${String(this.#treePolicy.maximumDepth)} was reached`,
        );
      }
      if (treeContext.rootRunId !== input.parentRunId) {
        const rootRun = await transaction
          .selectFrom("runs")
          .select("id")
          .where("tenant_id", "=", input.tenantId)
          .where("id", "=", treeContext.rootRunId)
          .forUpdate()
          .executeTakeFirst();
        if (rootRun === undefined) {
          throw new PostgresSubagentJobError(
            "parent_tree_invalid",
            "Subagent root Run was not found",
          );
        }
      }
      const treeNodes = await transaction
        .selectFrom("subagent_executions")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("tenant_id", "=", input.tenantId)
        .where("root_run_id", "=", treeContext.rootRunId)
        .executeTakeFirstOrThrow();
      if (Number(treeNodes.count) >= this.#treePolicy.maximumNodes) {
        throw new PostgresSubagentJobError(
          "subagent_tree_node_budget_exhausted",
          `Subagent tree node limit ${String(this.#treePolicy.maximumNodes)} was reached`,
        );
      }

      const policy = await transaction
        .selectFrom("tenant_runtime_policies")
        .select("maximum_sessions")
        .where("tenant_id", "=", input.tenantId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      const sessionCount = await transaction
        .selectFrom("sessions")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("tenant_id", "=", input.tenantId)
        .executeTakeFirstOrThrow();
      if (Number(sessionCount.count) >= policy.maximum_sessions) {
        throw new PostgresSubagentJobError(
          "tenant_session_quota",
          "Tenant Session quota does not have capacity for a Subagent",
        );
      }

      const executionId = this.#id();
      const childLaneStart =
        input.contextAnchor !== undefined
          ? input.contextAnchor
          : this.#nativeLanes.childAnchor(
              input.parentExecutionReference,
              input.contextMode === "branch",
            );
      const childSessionId = this.#id();
      const childPiSessionLane = `subagent-${executionId}`;
      const childTurnId = this.#id();
      const childRunId = this.#id();
      const childWorkspaceId = parent.workspaceId;
      const workingDirectory =
        input.cwd === undefined ? parent.workingDirectory : posix.resolve(input.cwd);
      const computeSessionId =
        input.sandboxMode === "ephemeral" ? childSessionId : parent.computeSessionId;
      if (computeSessionId !== null) {
        const root =
          parent.executionMode === "development_environment" ? "/home/user" : "/workspace";
        if (workingDirectory !== root && !workingDirectory.startsWith(root + "/"))
          throw new PostgresSubagentJobError(
            "subagent_directory_outside_volume",
            "Temporary compute requires a directory on the parent's shared Volume",
          );
      }
      const idempotencyKey = `subagent:${executionId}`;

      await transaction
        .insertInto("sessions")
        .values({
          id: childSessionId,
          pi_session_id: parent.piSessionId,
          pi_session_lane: childPiSessionLane,
          title: "Subagent",
          tenant_id: input.tenantId,
          project_id: parent.projectId,
          workspace_id: childWorkspaceId,
          desired_model_profile_id: parent.turnModelProfileId,
          desired_thinking_level: parent.thinkingLevel,
          desired_service_tier: parent.serviceTier,
          agent_revision_id: parent.agentRevisionId,
          created_by_user_id: parent.createdByUserId,
          state: "cold",
          execution_mode: parent.executionMode,
          development_environment_id: parent.developmentEnvironmentId,
          compute_session_id: computeSessionId,
          sandbox_profile_key: parent.sandboxProfileKey,
          working_directory: workingDirectory,
          session_kind: "subagent",
          tool_capabilities: sql<unknown[]>`${JSON.stringify(tools)}::jsonb`,
          forked_from_session_id: null,
          conversation_parent_session_id: null,
          conversation_fork_turn_id: null,
          conversation_fork_entry_id: null,
          archived_at: null,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("turns")
        .values({
          id: childTurnId,
          tenant_id: input.tenantId,
          session_id: childSessionId,
          state: "queued",
          input_kind: "prompt",
          input_text: input.prompt,
          model_profile_id: parent.turnModelProfileId,
          provider: parent.provider,
          model_id: parent.modelId,
          thinking_level: parent.thinkingLevel,
          service_tier: parent.serviceTier,
          credential_binding_id: parent.credentialBindingId,
          credential_binding_version: parent.credentialBindingVersion,
          stop_reason: null,
          failure_code: null,
          failure_message: null,
          failure_retryable: null,
        })
        .executeTakeFirstOrThrow();
      const childRun = await transaction
        .insertInto("runs")
        .values({
          id: childRunId,
          trace_id: traceId(childRunId),
          tenant_id: input.tenantId,
          project_id: parent.projectId,
          workspace_id: childWorkspaceId,
          session_id: childSessionId,
          turn_id: childTurnId,
          compute_session_id: computeSessionId,
          working_directory: workingDirectory,
          sandbox_profile_key: parent.sandboxProfileKey,
          agent_revision_id: parent.agentRevisionId,
          mailbox_position: 1,
          request_sha256: fingerprint,
          available_at: new Date("9999-12-31T23:59:59.999Z"),
          environment_version_id: parent.environmentVersionId,
          agent_system_prompt: childSystemPrompt(
            input.systemPrompt,
            treeContext.depth < this.#treePolicy.maximumDepth,
          ),
          tool_capability_snapshot: sql<unknown[]>`${JSON.stringify(tools)}::jsonb`,
          conversation_base_seq: 0,
          idempotency_key: idempotencyKey,
          state: "queued",
          current_attempt_id: null,
          attempt_count: 0,
          stop_reason: null,
          failure_code: null,
          failure_message: null,
          failure_retryable: null,
          started_at: null,
          settled_at: null,
        })
        .returning("created_at")
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("sessions")
        .set({ next_mailbox_position: 2, updated_at: childRun.created_at })
        .where("tenant_id", "=", input.tenantId)
        .where("id", "=", childSessionId)
        .executeTakeFirstOrThrow();
      await transaction
        .insertInto("subagent_executions")
        .values({
          id: executionId,
          tenant_id: input.tenantId,
          parent_session_id: input.parentSessionId,
          parent_run_id: input.parentRunId,
          parent_attempt_id: parentGrant.attemptId,
          parent_tool_call_id: input.parentToolCallId,
          root_session_id: treeContext.rootSessionId,
          root_run_id: treeContext.rootRunId,
          parent_execution_id: treeContext.parentExecutionId,
          depth: treeContext.depth,
          workflow_run_id: input.workflowRunId,
          step_index: input.stepIndex,
          request_sha256: fingerprint,
          child_session_id: childSessionId,
          child_run_id: childRunId,
          agent_name: input.agentName,
          context_mode: input.contextMode,
          pi_context_base_entry_id: childLaneStart,
          sandbox_mode: input.sandboxMode,
          state: "preparing",
          result_entry_id: null,
          failure_code: null,
          failure_message: null,
          settled_at: null,
        })
        .executeTakeFirstOrThrow();

      return {
        executionId,
        childSessionId,
        childRunId,
        state: "preparing" as const,
      };
    });
    if (pending.state === "preparing" && !deferPreparation)
      return this.prepareChild(input, pending);
    return pending;
  }

  async prepareChild(
    input: StartCloudSubagentJobInput,
    pending: CloudSubagentJobHandle,
  ): Promise<CloudSubagentJobHandle> {
    const parentGrant = parseExecutionReference(input.parentExecutionReference);
    const target = await this.#database
      .selectFrom("subagent_executions as execution")
      .innerJoin("sessions as child", (join) =>
        join
          .onRef("child.tenant_id", "=", "execution.tenant_id")
          .onRef("child.id", "=", "execution.child_session_id"),
      )
      .select([
        "execution.state",
        "child.workspace_id as workspaceId",
        "child.working_directory as cwd",
        "child.compute_session_id as computeSessionId",
        "child.execution_mode as executionMode",
        "child.development_environment_id as developmentEnvironmentId",
        "child.created_by_user_id as userId",
        "child.project_id as projectId",
        "child.id as sessionId",
        "child.pi_session_lane as lane",
        "execution.pi_context_base_entry_id as anchor",
      ])
      .where("execution.tenant_id", "=", input.tenantId)
      .where("execution.id", "=", pending.executionId)
      .executeTakeFirstOrThrow();
    if (target.state !== "preparing") return { ...pending, state: target.state };
    try {
      if (input.cwd !== undefined) {
        if (!this.#validateDirectory)
          throw new PostgresSubagentJobError(
            "subagent_directory_validation_unavailable",
            "Subagent directory validation is unavailable",
          );
        try {
          await this.#validateDirectory({ ...target, tenantId: input.tenantId });
        } catch (error) {
          if (
            error &&
            typeof error === "object" &&
            "retryable" in error &&
            error.retryable === true
          )
            throw error;
          throw new PostgresSubagentJobError(
            "subagent_directory_unavailable",
            `Subagent cwd is not an accessible directory: ${target.cwd}`,
          );
        }
      }
      await this.#nativeLanes.createChildLane({
        executionReference: input.parentExecutionReference,
        lane: target.lane,
        at: target.anchor,
      });
      return await this.#database.transaction().execute(async (transaction) => {
        const authority = await transaction
          .selectFrom("runs as parent_run")
          .innerJoin("run_attempts as parent_attempt", (join) =>
            join
              .onRef("parent_attempt.tenant_id", "=", "parent_run.tenant_id")
              .onRef("parent_attempt.run_id", "=", "parent_run.id")
              .onRef("parent_attempt.id", "=", "parent_run.current_attempt_id"),
          )
          .select([
            "parent_run.state as runState",
            "parent_run.current_attempt_id as attemptId",
            "parent_attempt.state as attemptState",
            "parent_attempt.lease_id as executionReferenceId",
            "parent_attempt.fencing_token as fencingToken",
          ])
          .where("parent_run.tenant_id", "=", input.tenantId)
          .where("parent_run.id", "=", input.parentRunId)
          .forUpdate(["parent_run", "parent_attempt"])
          .executeTakeFirst();
        const execution = await transaction
          .selectFrom("subagent_executions")
          .select(["state", "child_session_id", "child_run_id"])
          .where("tenant_id", "=", input.tenantId)
          .where("id", "=", pending.executionId)
          .forUpdate()
          .executeTakeFirstOrThrow();
        if (execution.state !== "preparing") {
          return { ...pending, state: execution.state };
        }
        if (
          authority?.runState !== "running" ||
          authority.attemptState !== "running" ||
          authority.attemptId !== parentGrant.attemptId ||
          authority.executionReferenceId !== parentGrant.leaseId ||
          Number(authority.fencingToken) !== parentGrant.fencingToken
        ) {
          throw new PostgresSubagentJobError(
            "parent_authority_expired",
            "Parent Agent Run lost authority while preparing the child",
          );
        }
        await transaction
          .updateTable("runs")
          .set({ available_at: new Date(Date.now() + LOCAL_CHILD_CLAIM_GRACE_MS) })
          .where("tenant_id", "=", input.tenantId)
          .where("id", "=", execution.child_run_id)
          .where("state", "=", "queued")
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("subagent_executions")
          .set({ state: "queued", updated_at: sql<Date>`now()` })
          .where("tenant_id", "=", input.tenantId)
          .where("id", "=", pending.executionId)
          .where("state", "=", "preparing")
          .executeTakeFirstOrThrow();
        return { ...pending, state: "queued" as const };
      });
    } catch (error: unknown) {
      if (error && typeof error === "object" && "retryable" in error && error.retryable === true)
        throw error;
      await this.#failPreparation(
        input.tenantId,
        pending,
        error instanceof PostgresSubagentJobError ? error.code : "child_preparation_failed",
        error instanceof PostgresSubagentJobError ? error.message : "Subagent preparation failed",
      ).catch(() => undefined);
      throw error;
    }
  }

  async #failPreparation(
    tenantId: string,
    pending: CloudSubagentJobHandle,
    failureCode: string,
    failureMessage: string,
  ): Promise<void> {
    const now = new Date();
    await this.#database.transaction().execute(async (transaction) => {
      const execution = await transaction
        .selectFrom("subagent_executions")
        .select(["state", "child_session_id", "child_run_id"])
        .where("tenant_id", "=", tenantId)
        .where("id", "=", pending.executionId)
        .forUpdate()
        .executeTakeFirst();
      if (execution === undefined || execution.state !== "preparing") return;
      const run = await transaction
        .selectFrom("runs")
        .select("turn_id")
        .where("tenant_id", "=", tenantId)
        .where("id", "=", execution.child_run_id)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("subagent_executions")
        .set({
          state: "failed",
          failure_code: failureCode,
          failure_message: failureMessage,
          settled_at: now,
          updated_at: now,
        })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", pending.executionId)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("runs")
        .set({
          state: "failed",
          failure_code: failureCode,
          failure_message: failureMessage,
          failure_retryable: false,
          settled_at: now,
          updated_at: now,
        })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", execution.child_run_id)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("turns")
        .set({
          state: "failed",
          failure_code: failureCode,
          failure_message: failureMessage,
          failure_retryable: false,
          settled_at: now,
        })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", run.turn_id)
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("sessions")
        .set({ state: "failed", updated_at: now })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", execution.child_session_id)
        .executeTakeFirstOrThrow();
    });
  }

  async status(tenantId: string, executionId: string): Promise<CloudSubagentJobResult> {
    const row = await this.#database
      .selectFrom("subagent_executions as execution")
      .innerJoin("runs as child_run", (join) =>
        join
          .onRef("child_run.tenant_id", "=", "execution.tenant_id")
          .onRef("child_run.id", "=", "execution.child_run_id"),
      )
      .select([
        "execution.id as executionId",
        sql<boolean>`exists(select 1 from run_attempts a where a.id=child_run.current_attempt_id
          and a.output_sealed_at is null)`.as("awaitingSeal"),
        "execution.child_session_id as childSessionId",
        "execution.child_run_id as childRunId",
        "execution.sandbox_mode as sandboxMode",
        "execution.state as executionState",
        "child_run.state as runState",
        "child_run.failure_code as failureCode",
        "child_run.failure_message as failureMessage",
      ])
      .where("execution.tenant_id", "=", tenantId)
      .where("execution.id", "=", executionId)
      .executeTakeFirst();
    if (row === undefined) {
      throw new PostgresSubagentJobError("not_found", "Subagent execution was not found");
    }
    if (row.executionState === "preparing") {
      return {
        executionId: row.executionId,
        childSessionId: row.childSessionId,
        childRunId: row.childRunId,
        state: "preparing",
      };
    }
    const state =
      row.awaitingSeal && ["completed", "failed", "cancelled"].includes(row.runState)
        ? "running"
        : mapRunState(row.runState);
    const terminal = ["completed", "failed", "cancelled", "unknown"].includes(state);
    await this.#database.transaction().execute(async (transaction) => {
      await transaction
        .updateTable("subagent_executions")
        .set({
          state,
          failure_code: state === "failed" ? (row.failureCode ?? "child_run_failed") : null,
          failure_message: state === "failed" ? row.failureMessage : null,
          ...(terminal ? { settled_at: sql<Date>`coalesce(settled_at, now())` } : {}),
          updated_at: sql<Date>`now()`,
        })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", executionId)
        .where("state", "in", ["preparing", "queued", "running"])
        .executeTakeFirst();
    });
    return {
      executionId: row.executionId,
      childSessionId: row.childSessionId,
      childRunId: row.childRunId,
      state,
      ...(row.failureCode === null ? {} : { failureCode: row.failureCode }),
      ...(row.failureMessage === null ? {} : { failureMessage: row.failureMessage }),
    };
  }

  async treeContext(tenantId: string, childRunId: string): Promise<CloudSubagentTreeContext> {
    const row = await this.#database
      .selectFrom("subagent_executions")
      .select([
        "id as executionId",
        "root_session_id as rootSessionId",
        "root_run_id as rootRunId",
        "parent_execution_id as parentExecutionId",
        "depth",
      ])
      .where("tenant_id", "=", tenantId)
      .where("child_run_id", "=", childRunId)
      .executeTakeFirst();
    if (row === undefined) {
      throw new PostgresSubagentJobError(
        "parent_tree_invalid",
        "Subagent Run is missing its durable tree identity",
      );
    }
    const nodeCount = await this.#database
      .selectFrom("subagent_executions")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("tenant_id", "=", tenantId)
      .where("root_run_id", "=", row.rootRunId)
      .executeTakeFirstOrThrow();
    return {
      executionId: row.executionId,
      rootSessionId: row.rootSessionId,
      rootRunId: row.rootRunId,
      ...(row.parentExecutionId === null ? {} : { parentExecutionId: row.parentExecutionId }),
      depth: row.depth,
      canSpawnChildren:
        row.depth < this.#treePolicy.maximumDepth &&
        Number(nodeCount.count) < this.#treePolicy.maximumNodes,
    };
  }

  async result(tenantId: string, executionId: string): Promise<CloudSubagentJobResult> {
    const status = await this.status(tenantId, executionId);
    if (status.state !== "completed") return status;
    const binding = await this.#database
      .selectFrom("sessions")
      .select(["pi_session_id as piSessionId", "pi_session_lane as piSessionLane"])
      .where("tenant_id", "=", tenantId)
      .where("id", "=", status.childSessionId)
      .executeTakeFirstOrThrow();
    const run = await this.#database
      .selectFrom("runs")
      .select("turn_id")
      .where("id", "=", status.childRunId)
      .where("tenant_id", "=", tenantId)
      .executeTakeFirstOrThrow();
    const final = await this.#database
      .selectFrom("pi_session_entries")
      .select(["id", "payload"])
      .where("tenant_id", "=", tenantId)
      .where("session_id", "=", binding.piSessionId)
      .where("turn_id", "=", run.turn_id)
      .where("type", "=", "message")
      .where(sql<string>`payload->'message'->>'role'`, "=", "assistant")
      .orderBy("seq", "desc")
      .limit(1)
      .executeTakeFirst();
    const message = (final?.payload as { message?: AgentMessage } | undefined)?.message;
    const assistantOutput = message?.role === "assistant" ? assistantText(message) : undefined;
    if (final)
      await this.#database
        .updateTable("subagent_executions")
        .set({ result_entry_id: final.id })
        .where("tenant_id", "=", tenantId)
        .where("id", "=", executionId)
        .execute();
    return { ...status, ...(assistantOutput === undefined ? {} : { output: assistantOutput }) };
  }

  async cancel(tenantId: string, executionId: string): Promise<CloudSubagentJobResult> {
    const childExecutions = await this.#database
      .selectFrom("subagent_executions")
      .select("id")
      .where("tenant_id", "=", tenantId)
      .where("parent_execution_id", "=", executionId)
      .orderBy("created_at", "desc")
      .execute();
    for (const child of childExecutions) await this.cancel(tenantId, child.id);
    await this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom("subagent_executions as execution")
        .innerJoin("runs as run", (join) =>
          join
            .onRef("run.tenant_id", "=", "execution.tenant_id")
            .onRef("run.id", "=", "execution.child_run_id"),
        )
        .select([
          "execution.state as executionState",
          "execution.child_session_id as sessionId",
          "execution.child_run_id as runId",
          "run.state as runState",
          "run.turn_id as turnId",
        ])
        .where("execution.tenant_id", "=", tenantId)
        .where("execution.id", "=", executionId)
        .forUpdate(["execution", "run"])
        .executeTakeFirst();
      if (row === undefined) {
        throw new PostgresSubagentJobError("not_found", "Subagent execution was not found");
      }
      if (["completed", "failed", "cancelled", "unknown"].includes(row.executionState)) return;
      const now = new Date();
      if (row.executionState === "preparing" || row.runState === "queued") {
        await transaction
          .updateTable("runs")
          .set({ state: "cancelled", settled_at: now, updated_at: now })
          .where("tenant_id", "=", tenantId)
          .where("id", "=", row.runId)
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("turns")
          .set({ state: "cancelled", settled_at: now })
          .where("tenant_id", "=", tenantId)
          .where("id", "=", row.turnId)
          .executeTakeFirstOrThrow();
        await transaction
          .updateTable("subagent_executions")
          .set({ state: "cancelled", settled_at: now, updated_at: now })
          .where("tenant_id", "=", tenantId)
          .where("id", "=", executionId)
          .executeTakeFirstOrThrow();
        return;
      }
      const existing = await transaction
        .selectFrom("turn_control_requests")
        .select("id")
        .where("tenant_id", "=", tenantId)
        .where("session_id", "=", row.sessionId)
        .where("turn_id", "=", row.turnId)
        .where("kind", "=", "cancel")
        .where("state", "in", ["pending", "dispatched", "acknowledged"])
        .executeTakeFirst();
      if (existing !== undefined) return;
      const controlRequestId = this.#id();
      const requestSha256 = createHash("sha256")
        .update(`pi-cloud.subagent-cancel.v1\0${executionId}`, "utf8")
        .digest("hex");
      await transaction
        .insertInto("turn_control_requests")
        .values({
          id: controlRequestId,
          tenant_id: tenantId,
          session_id: row.sessionId,
          turn_id: row.turnId,
          target_run_id: row.runId,
          idempotency_key: `subagent-cancel:${executionId}`,
          kind: "cancel",
          state: "pending",
          request_sha256: requestSha256,
          payload: {
            schemaVersion: 1,
            reason: "user_request",
            gracePeriodMs: 2_000,
          },
          attempts: 0,
          available_at: now,
          dispatched_at: null,
          acknowledged_at: null,
          completed_at: null,
          failure_code: null,
        })
        .onConflict((conflict) => conflict.doNothing())
        .executeTakeFirstOrThrow();
    });
    return this.status(tenantId, executionId);
  }

  async reapStalePreparations(maximumAgeMs = 20 * 60_000, limit = 32): Promise<number> {
    if (!Number.isSafeInteger(maximumAgeMs) || maximumAgeMs < 60_000) {
      throw new TypeError("Subagent preparation maximum age is invalid");
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      throw new TypeError("Subagent preparation reaper limit is invalid");
    }
    const terminal = await this.#database
      .selectFrom("subagent_executions as execution")
      .innerJoin("runs as child_run", (join) =>
        join
          .onRef("child_run.tenant_id", "=", "execution.tenant_id")
          .onRef("child_run.id", "=", "execution.child_run_id"),
      )
      .select(["execution.tenant_id as tenantId", "execution.id"])
      .where("execution.state", "in", ["queued", "running"])
      .where("child_run.state", "in", [
        "completed",
        "failed",
        "cancelled",
        "timed_out",
        "superseded",
      ])
      .orderBy("child_run.settled_at", "asc")
      .limit(limit)
      .execute();
    for (const row of terminal) {
      const activeChildren = await this.#database
        .selectFrom("subagent_executions")
        .select("id")
        .where("tenant_id", "=", row.tenantId)
        .where("parent_execution_id", "=", row.id)
        .where("state", "in", ["preparing", "queued", "running"])
        .execute();
      for (const child of activeChildren) await this.cancel(row.tenantId, child.id);
      await this.status(row.tenantId, row.id);
    }

    const stale = await this.#database
      .selectFrom("subagent_executions")
      .select([
        "tenant_id as tenantId",
        "id",
        "child_session_id as childSessionId",
        "child_run_id as childRunId",
        "state",
      ])
      .where("state", "=", "preparing")
      .where("updated_at", "<", new Date(Date.now() - maximumAgeMs))
      .orderBy("updated_at", "asc")
      .limit(limit)
      .execute();
    let reaped = terminal.length;
    for (const row of stale) {
      await this.#failPreparation(
        row.tenantId,
        {
          executionId: row.id,
          childSessionId: row.childSessionId,
          childRunId: row.childRunId,
          state: row.state,
        },
        "subagent_preparation_abandoned",
        "Subagent preparation did not complete before its deadline",
      );
      reaped += 1;
    }
    return reaped;
  }
}
