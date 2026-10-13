import { randomUUID } from "node:crypto";
import {
  controlToolDefinitions,
  validateSubagentControl,
  validateSubagentTask,
  type ExecuteTurnCommandMessage,
  type ToolResultPayload,
  type SubagentTask,
} from "@pi-cloud/protocol";
import {
  toolInvocationId,
  type TrustedAgentTool,
  type SubagentControlClient,
} from "@pi-cloud/sandbox-supervisor";
import type { WorkflowPreparer } from "@pi-cloud/sandbox-supervisor";

/** Definitions, frozen invocation metadata and reply transport only. Trusted
 * Tool business logic runs in Control Plane handlers; scripts stay in Cube. */
export class WorkerToolRuntime {
  constructor(
    readonly options: {
      nativeConversations: {
        childAnchor(
          reference: string,
          inherit: boolean,
          conversationId: number,
        ): Promise<string | null>;
        conversationDepth(reference: string, conversationId: number): Promise<number>;
      };
      control: Pick<SubagentControlClient, "request">;
      maximumDepth: number | null;
      wait(
        operationId: string,
        callId: string,
        toolName: string,
        signal: AbortSignal,
        scope: { tenantId: string; runId: string },
      ): Promise<ToolResultPayload>;
    },
  ) {}

  async create(context: {
    command: ExecuteTurnCommandMessage;
    prepareWorkflow: WorkflowPreparer;
    prepareEnvironment(): Promise<string>;
  }): Promise<readonly TrustedAgentTool[]> {
    const scope = context.command.payload;
    const depth =
      scope.sessionKind === "subagent"
        ? await this.options.nativeConversations.conversationDepth(
            scope.executionReference,
            scope.piSession.conversationId,
          )
        : 0;
    const hostcalls = new Map<
      string,
      {
        fingerprint: string;
        result: Promise<Record<string, unknown>>;
        published: Promise<void>;
      }
    >();
    const workflowCall = async (
      id: string,
      method: string,
      args: Record<string, unknown>,
      signal?: AbortSignal,
    ): Promise<Record<string, unknown>> => {
      if (method === "run") {
        if (typeof args.key !== "string" || !args.task || typeof args.task !== "object")
          throw new Error("runs.run requires a key and task specification");
        const task = { ...args.task, key: args.key } as SubagentTask;
        validateSubagentTask(task);
        const key = JSON.stringify([id, task.key]),
          fingerprint = JSON.stringify(task);
        const prior = hostcalls.get(key);
        if (prior) {
          if (prior.fingerprint !== fingerprint) throw new Error("Workflow key changed arguments");
          return prior.result;
        }
        const publication = Promise.withResolvers<void>();
        void publication.promise.catch(() => {});
        const result = (async () =>
          this.options.control.request({
            executionReference: scope.executionReference,
            conversationId: scope.piSession.conversationId,
            toolCallId: id,
            request: {
              action: "run",
              key: task.key,
              task: task.task,
              context: task.context ?? "fresh",
              sandbox: task.tools?.length === 0 ? "none" : (task.sandbox ?? "shared"),
              anchor: await this.options.nativeConversations.childAnchor(
                scope.executionReference,
                task.context === "branch",
                scope.piSession.conversationId,
              ),
              ...(task.cwd ? { cwd: task.cwd } : {}),
              ...(task.tools ? { tools: task.tools } : {}),
            },
            onPublished: () => publication.resolve(),
            ...(signal ? { signal } : {}),
          }))();
        void result.catch(publication.reject);
        hostcalls.set(key, { fingerprint, result, published: publication.promise });
        return result;
      }
      if (typeof args.target === "string")
        await hostcalls.get(JSON.stringify([id, args.target]))?.published;
      return this.options.control.request({
        executionReference: scope.executionReference,
        conversationId: scope.piSession.conversationId,
        toolCallId: id,
        request: validateSubagentControl({ ...args, action: method }),
        ...(signal ? { signal } : {}),
      });
    };

    return controlToolDefinitions().map((definition) => ({
      executionPlane:
        definition.name === "preview" ? ("platform" as const) : ("orchestration" as const),
      offered:
        definition.availability === "child"
          ? scope.sessionKind === "subagent"
          : definition.availability !== "delegation" ||
            this.options.maximumDepth === null ||
            depth < this.options.maximumDepth,
      tool: {
        ...definition,
        async execute() {
          throw new Error("Tool requires its committed native invocation");
        },
        prepareExecution: async (nativeCallId: string, raw: unknown, signal?: AbortSignal) => {
          const args = raw as Record<string, unknown>,
            invocationId = toolInvocationId(nativeCallId);
          const script = definition.workflowScript?.(args);
          if (script !== undefined)
            return context.prepareWorkflow(
              nativeCallId,
              script,
              (method, args, signal) => workflowCall(invocationId, method, args, signal),
              signal,
              definition.name,
            );
          const operationId = randomUUID();
          const bindingId = definition.requiresEnvironment
            ? await context.prepareEnvironment()
            : undefined;
          const anchor = await this.options.nativeConversations.childAnchor(
            scope.executionReference,
            definition.inheritedContext?.(args) ?? false,
            scope.piSession.conversationId,
          );
          const waiting = new AbortController();
          const activeSignal = signal ? AbortSignal.any([signal, waiting.signal]) : waiting.signal;
          const pending = this.options.wait(
            operationId,
            nativeCallId,
            definition.name,
            activeSignal,
            { tenantId: scope.tenantId, runId: scope.runId },
          );
          let completed = false;
          void pending.then(
            () => {
              completed = true;
            },
            () => {},
          );
          return {
            command: {
              target: "control" as const,
              executionReference: scope.executionReference,
              operationId,
              toolCallId: invocationId,
              nativeCallId,
              conversationId: scope.piSession.conversationId,
              toolName: definition.name,
              arguments: args,
              contextAnchor: anchor === null ? null : Number(anchor),
              ...(bindingId ? { bindingId } : {}),
              occurredAt: new Date().toISOString(),
            },
            completed: () => completed,
            dispose: () => waiting.abort(new Error("Control Tool wait ended")),
            result: async () => {
              const reply = await pending;
              return { ...reply.result, isError: reply.isError };
            },
          };
        },
      },
    }));
  }
}
