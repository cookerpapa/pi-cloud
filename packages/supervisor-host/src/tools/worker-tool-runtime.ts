import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import {
  infrastructureToolDefinitions,
  isControlToolName,
  parseSubagentTaskId,
  type OriginalControlToolIntent,
  validateSubagentControl,
  validateSubagentTask,
  type ExecuteTurnCommandMessage,
  type ToolResultPayload,
  type ToolReplyWait,
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
        originalControlIntent(
          reference: string,
          conversationId: number,
          taskId: number,
          signal?: AbortSignal,
        ): Promise<OriginalControlToolIntent>;
      };
      control: Pick<SubagentControlClient, "request">;
      maximumDepth: number | null;
      wait(
        operationId: string,
        callId: string,
        toolName: string,
        signal: AbortSignal,
        scope: { tenantId: string; runId: string },
      ): ToolReplyWait<ToolResultPayload>;
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
    const prepareWorkflow = async (
      nativeCallId: string,
      invocationId: string,
      script: string,
      signal: AbortSignal | undefined,
      toolName: string,
    ) => {
      const lifetime = new AbortController();
      const activeSignal = signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal;
      const hostcalls = new Map<
        string,
        {
          fingerprint: string;
          result: Promise<Record<string, unknown>>;
          published: Promise<void>;
        }
      >();
      const workflowCall = async (
        method: string,
        args: Record<string, unknown>,
        callerSignal?: AbortSignal,
      ): Promise<Record<string, unknown>> => {
        const signal = callerSignal ? AbortSignal.any([activeSignal, callerSignal]) : activeSignal;
        signal.throwIfAborted();
        if (method === "run") {
          if (typeof args.key !== "string" || !args.task || typeof args.task !== "object")
            throw new Error("runs.run requires a key and task specification");
          const task = { ...args.task, key: args.key } as SubagentTask;
          validateSubagentTask(task);
          const key = task.key,
            fingerprint = JSON.stringify(task);
          const prior = hostcalls.get(key);
          if (prior) {
            if (prior.fingerprint !== fingerprint)
              throw new Error("Workflow key changed arguments");
            return prior.result;
          }
          const publication = Promise.withResolvers<void>();
          void publication.promise.catch(() => {});
          const result = (async () =>
            this.options.control.request({
              executionReference: scope.executionReference,
              conversationId: scope.piSession.conversationId,
              toolCallId: invocationId,
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
        if (typeof args.target === "string") await hostcalls.get(args.target)?.published;
        return this.options.control.request({
          executionReference: scope.executionReference,
          conversationId: scope.piSession.conversationId,
          toolCallId: invocationId,
          request: validateSubagentControl({ ...args, action: method }),
          ...(signal ? { signal } : {}),
        });
      };

      try {
        const prepared = await context.prepareWorkflow(
          nativeCallId,
          script,
          workflowCall,
          activeSignal,
          toolName,
        );
        let disposed = false;
        return {
          ...prepared,
          dispose() {
            if (disposed) return;
            disposed = true;
            lifetime.abort(new Error("Workflow invocation has closed"));
            try {
              prepared.dispose();
            } finally {
              hostcalls.clear();
            }
          },
        };
      } catch (error) {
        lifetime.abort(error);
        hostcalls.clear();
        throw error;
      }
    };

    return infrastructureToolDefinitions().map((definition) => {
      const prepare = async (
        nativeCallId: string,
        raw: unknown,
        signal?: AbortSignal,
        recovery = false,
      ) => {
        const args = raw as Record<string, unknown>,
          invocationId = toolInvocationId(nativeCallId);
        const script = definition.workflowScript?.(args);
        if (script !== undefined) {
          if (recovery) throw new Error("Workflow execution cannot be recovered");
          return prepareWorkflow(nativeCallId, invocationId, script, signal, definition.name);
        }
        if (!isControlToolName(definition.name)) throw new Error("Invalid control Tool definition");
        const original = recovery
          ? await this.options.nativeConversations.originalControlIntent(
              scope.executionReference,
              scope.piSession.conversationId,
              parseSubagentTaskId(invocationId),
              signal,
            )
          : undefined;
        if (
          original &&
          (definition.replay !== "safe" ||
            original.taskId !== parseSubagentTaskId(invocationId) ||
            original.conversationId !== scope.piSession.conversationId ||
            original.toolName !== definition.name ||
            original.nativeCallId !== nativeCallId ||
            !isDeepStrictEqual(original.arguments, args))
        )
          throw new Error("Recovered invocation differs from its original intent");
        const operationId = randomUUID();
        const bindingId = definition.requiresEnvironment
          ? await context.prepareEnvironment()
          : undefined;
        const anchor = original
          ? original.contextAnchor
          : await this.options.nativeConversations.childAnchor(
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
        void pending.result.catch(() => {});
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
            ...(original
              ? { recovery: { sequence: original.sequence, operationId: original.operationId } }
              : {}),
            ...(bindingId ? { bindingId } : {}),
            occurredAt: new Date().toISOString(),
          },
          completed: pending.executionSettled,
          dispose: () => waiting.abort(new Error("Control Tool wait ended")),
          result: async () => {
            const reply = await pending.result;
            return { ...reply.result, isError: reply.isError };
          },
        };
      };
      return {
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
          prepareExecution: (callId: string, args: unknown, signal?: AbortSignal) =>
            prepare(callId, args, signal),
          ...(definition.replay === "safe"
            ? {
                prepareRecovery: (callId: string, args: unknown, signal?: AbortSignal) =>
                  prepare(callId, args, signal, true),
              }
            : {}),
        },
      };
    });
  }
}
