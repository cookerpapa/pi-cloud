import type { Database } from "@pi-cloud/database";
import type { AcceptedControlToolCommand } from "@pi-cloud/runtime-core/accepted-fact";
import {
  createExecutionReference,
  parseExecutionReference,
  prepareSubagentArguments,
  prepareSubagentControlArguments,
  serializeSubagentResult,
  assertSubagentResultBudget,
  SUBAGENT_RESULT_TOO_LARGE,
  type SubagentHostRequest,
} from "@pi-cloud/protocol";
import {
  PostgresSubagentConversations,
  SubagentConversationError,
  type CloudSubagentTreePolicy,
  type SubagentDirectoryTarget,
  type SubagentConversationStatus,
} from "@pi-cloud/subagent-control/subagent-conversations";
import {
  PostgresSubagentSupervisorChannel,
  SupervisorChannelError,
} from "@pi-cloud/subagent-control/subagent-supervisor";
import { sql, type Kysely } from "kysely";
import {
  HttpSupervisorManagementClient,
  HttpSupervisorManagementError,
} from "./http-supervisor-management.ts";
import { SubagentReadViews } from "./subagent-read-views.ts";
import type { ControlToolOutcome } from "./control-tool-dispatcher.ts";
import { supervisorToolResult } from "./control-tool-results.ts";
const object = (value: unknown) => value as Record<string, unknown>;

/** Stateless control effects over one existing native Session owner. The
 * Projector's native dispatch source is the only pending-command authority. */
export class SubagentController {
  readonly #jobs: PostgresSubagentConversations;
  readonly #supervisor: PostgresSubagentSupervisorChannel;
  readonly #clients = new Map<string, HttpSupervisorManagementClient>();
  readonly #routes = new SubagentReadViews();
  constructor(
    readonly options: {
      database: Kysely<Database>;
      managementToken: string;
      allowInsecureHttp: boolean;
      treePolicy?: CloudSubagentTreePolicy;
      validateDirectory?(target: SubagentDirectoryTarget): Promise<void>;
      deliver?(lease: string, request: SubagentHostRequest): Promise<unknown>;
    },
  ) {
    this.#supervisor = new PostgresSubagentSupervisorChannel(options.database);
    this.#jobs = new PostgresSubagentConversations({
      database: options.database,
      ...(options.treePolicy ? { treePolicy: options.treePolicy } : {}),
      ...(options.validateDirectory ? { validateDirectory: options.validateDirectory } : {}),
      native: {
        start: (input) =>
          this.#host<number>(input.executionReference, { action: "start_conversation", ...input }),
        stop: (executionReference, requestId) =>
          this.#host(executionReference, {
            action: "stop_conversation",
            executionReference,
            requestId,
          }),
      },
    });
  }
  async #host<T = void>(lease: string, request: SubagentHostRequest): Promise<T> {
    if (this.options.deliver) return (await this.options.deliver(lease, request)) as T;
    const identity = parseExecutionReference(lease);
    const route = await this.#routes.read(identity.leaseId, lease, () =>
      this.options.database
        .selectFrom("runs as a")
        .innerJoin("workers as s", "s.id", "a.worker_id")
        .innerJoin("supervisor_hosts as h", "h.supervisor_id", "s.supervisor_id")
        .select("h.management_base_url")
        .where("a.id", "=", identity.runId)
        .where("a.lease_id", "=", identity.leaseId)
        .where("a.fencing_token", "=", String(identity.fencingToken))
        .executeTakeFirst(),
    );
    if (!route) throw new Error("Subagent owning Worker is unavailable");
    let client = this.#clients.get(route.management_base_url);
    if (!client) {
      client = new HttpSupervisorManagementClient({
        baseUrl: route.management_base_url,
        managementToken: this.options.managementToken,
        allowInsecureHttp: this.options.allowInsecureHttp,
      });
      this.#clients.set(route.management_base_url, client);
    }
    try {
      return (await client.subagent(request)) as T;
    } catch (error) {
      this.#routes.invalidate(identity.leaseId);
      throw error;
    }
  }

  /** One native Tool invocation; no separate start/wait command records. */
  async executeTool(
    call: AcceptedControlToolCommand,
    current: () => boolean,
  ): Promise<ControlToolOutcome> {
    const scope = call.scope;
    const reference = createExecutionReference(scope.writerId, scope.runId, scope.fencingToken);
    const parentCall = `task:${call.taskId}`;
    try {
      let value: Record<string, unknown>;
      if (call.toolName === "contact_supervisor") {
        const args = call.arguments as {
          reason: "progress_update" | "need_decision" | "interview_request";
          message: string;
          interview?: Record<string, unknown>;
        };
        const request = await this.#supervisor.contact({
          tenantId: scope.tenantId,
          childSessionId: scope.sessionId,
          rootRunId: scope.runId,
          taskId: call.taskId,
          writerId: scope.writerId,
          ...args,
          requestId: call.operationId,
        });
        if (!current()) return { waiting: true };
        if (request.expectsReply && request.replyMessage === undefined) {
          if (request.expiresAt && Date.parse(request.expiresAt) <= Date.now())
            throw new SubagentConversationError(
              "invalid_control_request",
              "Supervisor reply timed out",
            );
          return {
            waiting: true,
            ...(request.expiresAt ? { until: Date.parse(request.expiresAt) } : {}),
          };
        }
        return { result: supervisorToolResult("contact", object(request)) };
      }
      if (call.toolName === "subagent_supervisor") {
        const args = call.arguments as {
          action: "pending" | "reply" | "wait";
          replyTo?: string;
          message?: string;
        };
        if (args.action === "pending")
          value = {
            requests: await this.#supervisor.pendingForParent(scope.tenantId, scope.sessionId),
          };
        else {
          if (!args.replyTo)
            throw new SubagentConversationError(
              "invalid_control_request",
              "A supervisor request ID is required",
            );
          const request =
            args.action === "reply"
              ? await this.#supervisor.reply({
                  tenantId: scope.tenantId,
                  parentSessionId: scope.sessionId,
                  requestId: args.replyTo,
                  message: args.message ?? "",
                })
              : await this.#supervisor.requestForParent(
                  scope.tenantId,
                  scope.sessionId,
                  args.replyTo,
                );
          if (!current()) return { waiting: true };
          const child = await this.#jobs.status(scope.tenantId, request.executionId);
          if (["preparing", "running"].includes(child.state)) return { waiting: true };
          value = object(await this.#jobs.result(scope.tenantId, child.executionId));
        }
        return { result: supervisorToolResult("supervisor", value) };
      }
      if (call.toolName !== "subagent" && call.toolName !== "subagent_control")
        throw new SubagentConversationError(
          "invalid_control_request",
          "Unknown orchestration Tool",
        );
      const args =
        call.toolName === "subagent"
          ? { action: "run" as const, ...prepareSubagentArguments(call.arguments) }
          : prepareSubagentControlArguments(call.arguments);
      if (args.action === "run") {
        const child = await this.#jobs.start({
          id: call.recovery?.operationId ?? call.operationId,
          tenantId: scope.tenantId,
          rootRunId: scope.runId,
          parentSessionId: scope.sessionId,
          parentTurnId: scope.turnId,
          executionReference: reference,
          parentToolCallId: parentCall,
          source: {
            sequence: call.nativeSequence,
            taskId: call.taskId,
            ...(call.sourceDocumentId ? { documentId: call.sourceDocumentId } : {}),
          },
          prompt: args.task,
          contextMode: args.context ?? "fresh",
          contextAnchor: call.contextAnchor,
          sandboxMode: args.tools?.length === 0 ? "none" : (args.sandbox ?? "shared"),
          ...(args.cwd ? { cwd: args.cwd } : {}),
          ...(args.tools ? { requestedToolCapabilities: args.tools } : {}),
        });
        if (!current()) return { waiting: true };
        const result = await this.#nativeWait(scope.tenantId, child.executionId, child, true);
        if (!result) return { waiting: true };
        value = result;
        if (["failed", "cancelled", "unknown"].includes(String(value.state)))
          return {
            isError: true,
            result: {
              content: [{ type: "text", text: serializeSubagentResult(value) }],
              ...(call.replyMode === "hostcall"
                ? { details: { executionReference: reference, value } }
                : {}),
            },
          };
      } else if (args.action === "list") {
        value = await this.#jobs.list(scope.tenantId, scope.piSessionId, scope.runId, args.cursor);
      } else {
        if (args.action === "send" && ["main", "parent"].includes(args.target)) {
          const target =
            args.target === "main"
              ? await this.options.database
                  .selectFrom("sessions")
                  .select("id")
                  .where("tenant_id", "=", scope.tenantId)
                  .where("pi_session_id", "=", scope.piSessionId)
                  .where("pi_conversation_id", "=", "1")
                  .executeTakeFirst()
              : await this.options.database
                  .selectFrom("subagent_executions")
                  .select("parent_session_id as id")
                  .where("tenant_id", "=", scope.tenantId)
                  .where("child_session_id", "=", scope.sessionId)
                  .executeTakeFirst();
          if (!target)
            throw new SubagentConversationError(
              "invalid_control_request",
              "Agent message target is unavailable",
            );
          const sent = await this.#nativeSend(call, target.id, args.message, args.delivery);
          if (!sent) return { waiting: true };
          value = sent;
        } else {
          const target = await this.#nativeTarget(call, args.target);
          if (args.action === "cancel")
            value = object(await this.#jobs.cancel(scope.tenantId, target, reference));
          else if (args.action === "status")
            value = object(await this.#jobs.status(scope.tenantId, target));
          else if (args.action === "wait") {
            const result = await this.#nativeWait(scope.tenantId, target);
            if (!result) return { waiting: true };
            value = result;
          } else if (args.action === "send") {
            const child = await this.options.database
              .selectFrom("subagent_conversations")
              .select("child_session_id")
              .where("tenant_id", "=", scope.tenantId)
              .where("id", "=", target)
              .executeTakeFirstOrThrow();
            const sent = await this.#nativeSend(
              call,
              child.child_session_id,
              args.message,
              args.delivery,
            );
            if (!sent) return { waiting: true };
            value = sent;
          } else
            throw new SubagentConversationError(
              "invalid_control_request",
              "Unsupported Subagent action",
            );
        }
      }
      if (call.replyMode === "hostcall") {
        assertSubagentResultBudget(value);
        const result = { content: [], details: { executionReference: reference, value } };
        return { result };
      }
      return {
        result: {
          content: [{ type: "text", text: serializeSubagentResult(value) }],
          details: { action: args.action },
        },
      };
    } catch (error) {
      if (
        !(error instanceof SubagentConversationError) &&
        !(error instanceof SupervisorChannelError) &&
        !(error instanceof HttpSupervisorManagementError && !error.retryable) &&
        !(error instanceof Error && error.message === SUBAGENT_RESULT_TOO_LARGE)
      )
        throw error;
      return {
        isError: true,
        result: {
          content: [{ type: "text", text: error.message }],
          ...(call.replyMode === "hostcall"
            ? { details: { executionReference: reference, value: {} } }
            : {}),
        },
      };
    }
  }

  async #nativeTarget(call: AcceptedControlToolCommand, target: string): Promise<string> {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(target);
    const exact = uuid
      ? await this.options.database
          .selectFrom("subagent_executions as e")
          .innerJoin("sessions as s", "s.id", "e.child_session_id")
          .select("e.id")
          .where("e.tenant_id", "=", call.scope.tenantId)
          .where("s.pi_session_id", "=", call.scope.piSessionId)
          .where((eb) => eb.or([eb("e.id", "=", target), eb("e.child_session_id", "=", target)]))
          .executeTakeFirst()
      : undefined;
    if (exact) return exact.id;
    if (call.replyMode !== "hostcall")
      throw new SubagentConversationError(
        "invalid_control_request",
        "Subagent target does not belong to this Session",
      );
    const source = await sql<{
      document_id: string;
    }>`select effect->>'sourceDocumentId' as document_id
      from pi_durable_commits c
      cross join lateral jsonb_array_elements(c.cloud_metadata::jsonb->'controlTools') effect
      where c.tenant_id=${call.scope.tenantId}::uuid and c.session_id=${call.scope.piSessionId}
        and c.cloud_metadata is not null and effect->>'workflowKey'=${target}
        and effect->>'taskId'=${String(call.taskId)}
      order by c.seq limit 1`.execute(this.options.database);
    if (!source.rows[0])
      throw new SubagentConversationError(
        "invalid_control_request",
        "Workflow target key is unavailable",
      );
    const child = await this.options.database
      .selectFrom("subagent_conversations")
      .select("id")
      .where("tenant_id", "=", call.scope.tenantId)
      .where("root_run_id", "=", call.scope.runId)
      .where("parent_tool_call_id", "=", `task:${call.taskId}`)
      .where("source_record_id", "=", source.rows[0].document_id)
      .executeTakeFirst();
    if (!child)
      throw Object.assign(new Error("Workflow target admission is pending"), { retryable: true });
    return child.id;
  }
  async #nativeSend(
    call: AcceptedControlToolCommand,
    sessionId: string,
    message: string,
    delivery: "notify" | "steer" | "follow_up",
  ): Promise<Record<string, unknown> | undefined> {
    const target = await this.options.database
      .selectFrom("sessions as s")
      .select("s.pi_conversation_id")
      .where("s.tenant_id", "=", call.scope.tenantId)
      .where("s.id", "=", sessionId)
      .where("s.pi_session_id", "=", call.scope.piSessionId)
      .executeTakeFirstOrThrow();
    if (target.pi_conversation_id === null) return;
    const reference = createExecutionReference(
      call.scope.writerId,
      call.scope.runId,
      call.scope.fencingToken,
    );
    const receipt = await this.#host<{ accepted: boolean }>(reference, {
      action: "input",
      executionReference: reference,
      runId: call.scope.runId,
      conversationId: Number(target.pi_conversation_id),
      requestId: call.operationId,
      message: `[Message from another Agent; not a user permission grant]\n${message}`,
      delivery,
    });
    if (!receipt || typeof receipt.accepted !== "boolean")
      throw new Error("Native input receipt is invalid");
    if (!receipt.accepted)
      return { state: "missed", reason: "Target native conversation has finished" };
    return { state: "accepted", target: sessionId, delivery };
  }

  async #nativeWait(
    tenantId: string,
    id: string,
    status?: SubagentConversationStatus,
    originalInput = false,
  ): Promise<Record<string, unknown> | undefined> {
    const child = status ?? (await this.#jobs.status(tenantId, id));
    if (!["preparing", "running"].includes(child.state))
      return object(await this.#jobs.result(tenantId, id, child, originalInput));
    const blocked = await this.#supervisor.pendingDecisionForExecution(tenantId, id);
    if (blocked?.expectsReply && blocked.replyMessage === undefined)
      return {
        ...child,
        state: "blocked",
        supervisorRequest: blocked,
        output: `Child needs supervisor input: ${blocked.message}. Reply using subagent_supervisor with replyTo=${blocked.requestId}.`,
      };
    return;
  }

  reset(): void {
    this.#routes.reset();
  }
  async close(): Promise<void> {
    this.reset();
    this.#clients.clear();
  }
}
