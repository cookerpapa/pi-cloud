import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { resourceLimit } from "@pi-cloud/domain";
import type {
  Database,
  SubagentContextMode,
  SubagentExecutionState,
  SubagentSandboxMode,
} from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import {
  parseCloudToolCapabilitySnapshot,
  parseExecutionReference,
  parseSubagentTaskId,
  assertSubagentTaskInputBudget,
  type CloudToolCapabilitySnapshot,
  type ConversationStartRequest,
  type ConversationWorkView,
} from "@pi-cloud/protocol";

export type CloudSubagentTreePolicy = { maximumDepth: number | null; maximumNodes: number | null };
export const DEFAULT_CLOUD_SUBAGENT_TREE_POLICY: CloudSubagentTreePolicy = {
  maximumDepth: null,
  maximumNodes: null,
};
export type SubagentDirectoryTarget = {
  tenantId: string;
  workspaceId: string;
  sessionId: string;
  cwd: string;
  executionMode: "elastic" | "development_environment";
  computeSessionId: string | null;
  developmentEnvironmentId: string | null;
  userId: string | null;
};
export type StartSubagentConversation = {
  id: string;
  tenantId: string;
  rootRunId: string;
  parentSessionId: string;
  parentTurnId: string;
  executionReference: string;
  parentToolCallId: string;
  source: ConversationWorkView["source"];
  prompt: string;
  contextMode: SubagentContextMode;
  contextAnchor: number | null;
  sandboxMode: SubagentSandboxMode;
  cwd?: string;
  requestedToolCapabilities?: CloudToolCapabilitySnapshot;
};
export type SubagentConversationStatus = {
  executionId: string;
  childSessionId: string;
  childTurnId: string;
  rootRunId: string;
  conversationId?: number;
  state: SubagentExecutionState;
  output?: string;
  failureCode?: string;
  failureMessage?: string;
};
function statusResource(row: {
  id: string;
  child_session_id: string;
  child_turn_id: string;
  root_run_id: string;
  state: SubagentExecutionState;
  failure_code: string | null;
  failure_message: string | null;
  pi_conversation_id: string | null;
}): SubagentConversationStatus {
  return {
    executionId: row.id,
    childSessionId: row.child_session_id,
    childTurnId: row.child_turn_id,
    rootRunId: row.root_run_id,
    state: row.state,
    ...(row.pi_conversation_id === null ? {} : { conversationId: Number(row.pi_conversation_id) }),
    ...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
    ...(row.failure_message === null ? {} : { failureMessage: row.failure_message }),
  };
}

export class SubagentConversationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** PG admits resources and indexes views. Pi creates and schedules every child;
 * no child Run is inserted, claimed, leased or settled here. */
export class PostgresSubagentConversations {
  readonly policy: CloudSubagentTreePolicy;
  constructor(
    readonly options: {
      database: Kysely<Database>;
      native: {
        start(input: ConversationStartRequest): Promise<number>;
        stop(reference: string, id: string): Promise<void>;
      };
      treePolicy?: CloudSubagentTreePolicy;
      validateDirectory?(target: SubagentDirectoryTarget): Promise<void>;
    },
  ) {
    this.policy = options.treePolicy ?? DEFAULT_CLOUD_SUBAGENT_TREE_POLICY;
    for (const [name, value] of Object.entries(this.policy))
      resourceLimit(value, `Subagent ${name}`);
  }
  async start(input: StartSubagentConversation): Promise<SubagentConversationStatus> {
    const ownerTaskId = parseSubagentTaskId(input.parentToolCallId);
    assertSubagentTaskInputBudget(input.prompt);
    if (
      input.cwd &&
      (!posix.isAbsolute(input.cwd) || input.cwd.length > 4096 || /[\x00-\x1f\x7f]/.test(input.cwd))
    )
      throw new SubagentConversationError(
        "invalid_directory",
        "Subagent cwd must be an absolute directory",
      );
    const grant = parseExecutionReference(input.executionReference);
    const fingerprint = createHash("sha256")
      .update(JSON.stringify({ ...input, executionReference: undefined }))
      .digest("hex");
    // Reconciliation after acknowledged native admission reads the current
    // outcome. Keep creation locks/RPCs for first or uncertain admission only.
    const known = await this.options.database
      .selectFrom("subagent_executions as e")
      .innerJoin("sessions as s", (join) =>
        join.onRef("s.tenant_id", "=", "e.tenant_id").onRef("s.id", "=", "e.child_session_id"),
      )
      .innerJoin("active_execution_scopes as a", (join) =>
        join.onRef("a.tenant_id", "=", "e.tenant_id").onRef("a.run_id", "=", "e.root_run_id"),
      )
      .select([
        "e.id",
        "e.child_session_id",
        "e.child_turn_id",
        "e.root_run_id",
        "e.state",
        "e.failure_code",
        "e.failure_message",
        "e.request_sha256",
        "s.pi_conversation_id",
      ])
      .where("e.tenant_id", "=", input.tenantId)
      .where("e.id", "=", input.id)
      .where("e.root_run_id", "=", input.rootRunId)
      .where("a.lease_id", "=", grant.leaseId)
      .where("a.fencing_token", "=", String(grant.fencingToken))
      .where("a.accepting_effects", "=", true)
      .where("a.valid_until", ">", sql<Date>`clock_timestamp()`)
      .executeTakeFirst();
    if (known) {
      if (known.request_sha256 !== fingerprint)
        throw new SubagentConversationError(
          "idempotency_conflict",
          "Child identity changed arguments",
        );
      if (known.pi_conversation_id !== null) return statusResource(known);
    }
    const prepared = await this.options.database.transaction().execute(async (tx) => {
      const root = await tx
        .selectFrom("runs")
        .selectAll()
        .where("tenant_id", "=", input.tenantId)
        .where("id", "=", input.rootRunId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      const parent = await tx
        .selectFrom("sessions")
        .selectAll()
        .where("tenant_id", "=", input.tenantId)
        .where("id", "=", input.parentSessionId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      const rootSession = await tx
        .selectFrom("sessions")
        .select("pi_session_id")
        .where("tenant_id", "=", input.tenantId)
        .where("id", "=", root.session_id)
        .executeTakeFirstOrThrow();
      if (
        root.id !== grant.runId ||
        root.lease_id !== grant.leaseId ||
        Number(root.fencing_token) !== grant.fencingToken ||
        root.state !== "running" ||
        root.output_sealed_at !== null ||
        parent.pi_session_id !== rootSession.pi_session_id ||
        parent.pi_conversation_id === null
      )
        throw new SubagentConversationError(
          "parent_authority_expired",
          "Parent no longer owns this Session",
        );
      const prior = await tx
        .selectFrom("subagent_conversations")
        .selectAll()
        .where("tenant_id", "=", input.tenantId)
        .where("id", "=", input.id)
        .executeTakeFirst();
      if (prior) {
        if (prior.request_sha256 !== fingerprint)
          throw new SubagentConversationError(
            "idempotency_conflict",
            "Child identity changed arguments",
          );
        const child = await tx
          .selectFrom("sessions")
          .selectAll()
          .where("tenant_id", "=", input.tenantId)
          .where("id", "=", prior.child_session_id)
          .executeTakeFirstOrThrow();
        return {
          child,
          depth: prior.depth,
          parentConversationId: Number(parent.pi_conversation_id),
          turnId: prior.child_turn_id,
        };
      }
      const parentView =
        parent.session_kind === "subagent"
          ? await tx
              .selectFrom("subagent_conversations")
              .select(["id", "depth", "root_run_id"])
              .where("tenant_id", "=", input.tenantId)
              .where("child_session_id", "=", parent.id)
              .executeTakeFirstOrThrow()
          : undefined;
      if (parentView && parentView.root_run_id !== root.id)
        throw new SubagentConversationError(
          "parent_work_changed",
          "Child parent belongs to another root work item",
        );
      const depth = (parentView?.depth ?? 0) + 1;
      if (this.policy.maximumDepth !== null && depth > this.policy.maximumDepth)
        throw new SubagentConversationError(
          "subagent_tree_depth_exhausted",
          "Subagent depth budget exhausted",
        );
      if (this.policy.maximumNodes !== null) {
        const count = await tx
          .selectFrom("subagent_conversations")
          .select(({ fn }) => fn.countAll<string>().as("n"))
          .where("tenant_id", "=", input.tenantId)
          .where("root_run_id", "=", root.id)
          .executeTakeFirstOrThrow();
        if (Number(count.n) >= this.policy.maximumNodes)
          throw new SubagentConversationError(
            "subagent_tree_nodes_exhausted",
            "Subagent tree budget exhausted",
          );
      }
      const tenant = await tx
        .selectFrom("tenant_runtime_policies")
        .select("maximum_sessions")
        .where("tenant_id", "=", input.tenantId)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (tenant.maximum_sessions !== null) {
        const count = await tx
          .selectFrom("sessions")
          .select(({ fn }) => fn.countAll<string>().as("n"))
          .where("tenant_id", "=", input.tenantId)
          .where("pruned_at", "is", null)
          .executeTakeFirstOrThrow();
        if (Number(count.n) >= tenant.maximum_sessions)
          throw new SubagentConversationError(
            "tenant_session_quota",
            "Tenant Session quota exhausted",
          );
      }
      const inherited = parseCloudToolCapabilitySnapshot(
        parent.session_kind === "subagent"
          ? parent.tool_capabilities
          : root.tool_capability_snapshot,
      );
      const tools =
        input.sandboxMode === "none"
          ? []
          : input.requestedToolCapabilities === undefined
            ? inherited
            : parseCloudToolCapabilitySnapshot(input.requestedToolCapabilities).filter((tool) =>
                inherited.includes(tool),
              );
      const sessionId = randomUUID(),
        turnId = randomUUID();
      const cwd = input.cwd ?? parent.working_directory;
      const compute = input.sandboxMode === "ephemeral" ? sessionId : parent.compute_session_id;
      const volumeRoot =
        parent.execution_mode === "development_environment" ? "/home/user" : "/workspace";
      if (compute !== null && cwd !== volumeRoot && !cwd.startsWith(`${volumeRoot}/`))
        throw new SubagentConversationError(
          "subagent_directory_outside_volume",
          "Temporary compute requires a directory on the shared Volume",
        );
      const child = await tx
        .insertInto("sessions")
        .values({
          id: sessionId,
          tenant_id: input.tenantId,
          pi_session_id: parent.pi_session_id,
          pi_conversation_id: null,
          title: "Subagent",
          project_id: root.project_id,
          workspace_id: root.workspace_id,
          desired_model_profile_id: root.model_profile_id,
          desired_thinking_level: root.thinking_level,
          desired_service_tier: root.service_tier,
          agent_revision_id: root.agent_revision_id,
          created_by_user_id: parent.created_by_user_id,
          state: "cold",
          execution_mode: parent.execution_mode,
          development_environment_id: parent.development_environment_id,
          compute_session_id: compute,
          sandbox_profile_key: root.sandbox_profile_key,
          working_directory: cwd,
          session_kind: "subagent",
          tool_capabilities: sql<unknown[]>`${JSON.stringify(tools)}::jsonb`,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await tx
        .insertInto("subagent_conversations")
        .values({
          id: input.id,
          tenant_id: input.tenantId,
          root_run_id: root.id,
          root_session_id: root.session_id,
          parent_session_id: parent.id,
          parent_turn_id: input.parentTurnId,
          parent_tool_call_id: input.parentToolCallId,
          parent_execution_id: parentView?.id ?? null,
          depth,
          source_sequence: String(input.source.sequence),
          source_record_id: String(input.source.documentId ?? input.source.taskId),
          source_kind: input.source.documentId === undefined ? "task" : "document.create",
          request_sha256: fingerprint,
          child_session_id: sessionId,
          child_turn_id: turnId,
          agent_name: "cloud-child",
          context_mode: input.contextMode,
          pi_context_base_entry_id:
            input.contextAnchor === null ? null : String(input.contextAnchor),
          sandbox_mode: input.sandboxMode,
        })
        .execute();
      return { child, depth, parentConversationId: Number(parent.pi_conversation_id), turnId };
    });
    const { child, depth } = prepared;
    // start() is also revisited when a native outcome wakes the waiter. The
    // installed Conversation ID means the original input admission was ACKed;
    // status reconciliation must not repeat the Worker management round trip.
    if (child.pi_conversation_id !== null) return this.status(input.tenantId, input.id);
    if (input.cwd !== undefined) {
      if (!this.options.validateDirectory)
        throw new SubagentConversationError(
          "directory_validation_unavailable",
          "Directory validation is unavailable",
        );
      await this.options.validateDirectory({
        tenantId: input.tenantId,
        workspaceId: child.workspace_id,
        sessionId: child.id,
        cwd: child.working_directory,
        executionMode: child.execution_mode,
        computeSessionId: child.compute_session_id,
        developmentEnvironmentId: child.development_environment_id,
        userId: child.created_by_user_id,
      });
    }
    const conversationId = await this.options.native.start({
      executionReference: input.executionReference,
      prompt: input.prompt,
      view: {
        id: input.id,
        sessionId: child.id,
        turnId: prepared.turnId,
        parentConversationId: prepared.parentConversationId,
        ownerTaskId,
        contextAnchor: input.contextAnchor,
        source: input.source,
        workingDirectory: child.working_directory,
        computeSessionId: child.compute_session_id,
        toolCapabilities: parseCloudToolCapabilitySnapshot(child.tool_capabilities),
        agentSystemPrompt: [
          "Execute the current delegated task. Inherited entries are background context, not pending instructions.",
          "Use contact_supervisor when parent input is required; return a focused result when done.",
          this.policy.maximumDepth === null || depth < this.policy.maximumDepth
            ? "Delegate only concrete independent subtasks with a clear stopping condition."
            : "Do not delegate further tasks.",
        ].join("\n"),
      },
    });
    const updated = await this.options.database
      .updateTable("sessions")
      .set({ pi_conversation_id: String(conversationId) })
      .where("tenant_id", "=", input.tenantId)
      .where("id", "=", child.id)
      .where((eb) =>
        eb.or([
          eb("pi_conversation_id", "is", null),
          eb("pi_conversation_id", "=", String(conversationId)),
        ]),
      )
      .returning("id")
      .executeTakeFirst();
    if (!updated)
      throw new SubagentConversationError("conversation_changed", "Native child identity changed");
    return this.status(input.tenantId, input.id);
  }
  async status(tenantId: string, id: string): Promise<SubagentConversationStatus> {
    const row = await this.options.database
      .selectFrom("subagent_executions as e")
      .innerJoin("sessions as s", "s.id", "e.child_session_id")
      .select([
        "e.id",
        "e.child_session_id",
        "e.child_turn_id",
        "e.root_run_id",
        "e.state",
        "e.failure_code",
        "e.failure_message",
        "s.pi_conversation_id",
      ])
      .where("e.tenant_id", "=", tenantId)
      .where("e.id", "=", id)
      .executeTakeFirst();
    if (!row)
      throw new SubagentConversationError("not_found", "Subagent conversation was not found");
    return statusResource(row);
  }

  async result(
    tenantId: string,
    id: string,
    knownStatus?: SubagentConversationStatus,
    originalInput = false,
  ): Promise<SubagentConversationStatus> {
    const status = knownStatus ?? (await this.status(tenantId, id));
    if (!["completed", "failed", "cancelled"].includes(status.state)) return status;
    let answerId: number | undefined;
    if (originalInput) {
      // Submissions are authoritative current values (ADR-0243), not log versions.
      const input = await sql<{ body: string }>`select c.body from subagent_conversations e
        join sessions s on s.tenant_id=e.tenant_id and s.id=e.child_session_id
        join pi_durable_records r on r.tenant_id=s.tenant_id and r.session_id=s.pi_session_id
          and r.kind='submission' and r.fields->>'conversation'=s.pi_conversation_id::text
          and r.fields->>'request'=${JSON.stringify(status.rootRunId)}
        join pi_durable_current c on c.tenant_id=r.tenant_id and c.session_id=r.session_id and c.id=r.id
        where e.tenant_id=${tenantId}::uuid and e.id=${id}::uuid`.execute(this.options.database);
      if (!input.rows[0]) throw new Error("Original child Submission is unavailable");
      const value = JSON.parse(input.rows[0].body).value as {
        type: string;
        status: string;
        answer?: number;
      };
      if (value.type !== "input" || value.status !== "done") return status;
      if (!Number.isSafeInteger(value.answer)) throw new Error("Original child answer is invalid");
      answerId = value.answer;
    }
    const rows = await sql<{ body: string }>`select l.body from pi_durable_records r
      join pi_durable_log l using(tenant_id,session_id,seq,ordinal)
      where r.tenant_id=${tenantId}::uuid and r.kind='entry' and r.fields->>'cloudSession'=${status.childSessionId}
        and r.fields->>'run'=${status.rootRunId} and r.fields->>'role'='assistant'
        and ${answerId === undefined ? sql`true` : sql`r.id=${answerId}`}
      order by r.id desc limit 1`.execute(this.options.database);
    const message = rows.rows[0]
      ? JSON.parse(rows.rows[0].body).value.model?.find(
          (m: { role: string }) => m.role === "assistant",
        )
      : undefined;
    const output = message?.content
      ?.filter((p: { type: string }) => p.type === "text")
      .map((p: { text: string }) => p.text)
      .join("");
    return { ...status, ...(output ? { output } : {}) };
  }
  async list(
    tenantId: string,
    piSessionId: string,
    runId: string,
    cursor?: string,
  ): Promise<Record<string, unknown>> {
    const pageSize = 24;
    const rows = await sql<{
      id: string;
      state: SubagentExecutionState;
      parent_execution_id: string | null;
      parent_tool_call_id: string;
      source_kind: string;
      body: string;
    }>`select e.id::text,e.state,e.parent_execution_id::text,e.parent_tool_call_id,e.source_kind,l.body
      from subagent_executions e join sessions s on s.tenant_id=e.tenant_id and s.id=e.child_session_id
      join pi_durable_log l on l.tenant_id=s.tenant_id and l.session_id=s.pi_session_id
        and l.seq=e.source_sequence and l.record_id=e.source_record_id and l.record_kind=e.source_kind
      where e.tenant_id=${tenantId}::uuid and s.pi_session_id=${piSessionId} and e.root_run_id=${runId}::uuid
        and ${cursor === undefined ? sql`true` : sql`e.id>${cursor}::uuid`}
      order by e.id limit ${pageSize + 1}`.execute(this.options.database);
    const agents = rows.rows.slice(0, pageSize).map((row) => {
      const source = JSON.parse(row.body);
      const args =
        row.source_kind === "task"
          ? source.value?.state?.checkpoint?.arguments
          : source.content?.value?.arguments;
      if (typeof args?.task !== "string") throw new Error("Child intent is unavailable");
      return {
        executionId: row.id,
        state: row.state,
        task: Array.from(args.task.trim() as string)
          .slice(0, 160)
          .join(""),
        sourceTaskId: parseSubagentTaskId(row.parent_tool_call_id),
        ...(row.parent_execution_id ? { parentExecutionId: row.parent_execution_id } : {}),
      };
    });
    return {
      agents,
      ...(rows.rows.length > pageSize ? { nextCursor: agents.at(-1)!.executionId } : {}),
    };
  }
  async cancel(
    tenantId: string,
    id: string,
    executionReference: string,
  ): Promise<SubagentConversationStatus> {
    const before = await this.status(tenantId, id);
    if (before.rootRunId !== parseExecutionReference(executionReference).runId)
      throw new SubagentConversationError(
        "wrong_root_work",
        "Cancellation belongs to another root work item",
      );
    if (["preparing", "running"].includes(before.state))
      await this.options.native.stop(executionReference, id);
    return this.status(tenantId, id);
  }
}
