import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import {
  infrastructureToolDefinitions,
  hasConversationWorkspace,
  isControlToolName,
  parseSubagentTaskId,
  type OriginalControlToolIntent,
  validateSubagentControl,
  validateSubagentTask,
  type ExecuteTurnCommandMessage,
  type ToolResultPayload,
  type ToolReplyWait,
  type SubagentTask,
  type ControlToolCatalogSource,
  type InfrastructureToolDefinition,
  type ExecutionTargetGrant,
  type ToolEnvironmentRequirement,
  type CandidateToolEffect,
  ToolExecutionFailure,
  ANDROID_REPLY_TIMEOUT_MS,
} from "@pi-cloud/protocol";
import {
  toolInvocationId,
  type TrustedAgentTool,
  type TrustedAgentToolSet,
  type PreparedAgentTool,
  type SubagentControlClient,
} from "@pi-cloud/sandbox-supervisor";
import type { WorkflowPreparer } from "@pi-cloud/sandbox-supervisor";

/** Definitions, frozen invocation metadata and reply transport only. Trusted
 * Tool business logic runs in Control Plane handlers; scripts stay in Cube. */
export class WorkerToolRuntime {
  constructor(
    readonly options: {
      catalog: ControlToolCatalogSource;
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
      prepareTarget?(
        command: ExecuteTurnCommandMessage,
        target: ExecutionTargetGrant,
        signal?: AbortSignal,
      ): Promise<string>;
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
    onExecutionUnavailable?(failure: { code: string; message: string }): void;
  }): Promise<TrustedAgentToolSet> {
    const scope = context.command.payload;
    const workspaceAvailable = hasConversationWorkspace(scope);
    const targetBindings = new Map<string, Promise<string>>();
    const prepareTarget = (target: ExecutionTargetGrant, signal?: AbortSignal) => {
      let pending = targetBindings.get(target.targetId);
      if (!pending) {
        pending = this.options.prepareTarget
          ? this.options.prepareTarget(context.command, target, signal)
          : Promise.reject(new Error("Device transport is unavailable"));
        targetBindings.set(target.targetId, pending);
        void pending.catch(() => {
          if (targetBindings.get(target.targetId) === pending)
            targetBindings.delete(target.targetId);
        });
      }
      return pending;
    };
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
      if (!workspaceAvailable)
        throw new Error("workspace_unavailable: this child has no Linux workspace");
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
                ...(task.workspace === undefined ? {} : { workspace: task.workspace }),
                anchor: await this.options.nativeConversations.childAnchor(
                  scope.executionReference,
                  task.context === "branch",
                  scope.piSession.conversationId,
                ),
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

    type Definition = Omit<InfrastructureToolDefinition, "name"> & {
      name: string;
      environment?: ToolEnvironmentRequirement;
    };
    const createBinding = (definition: Definition, ordinary: boolean): TrustedAgentTool => {
      const environment = definition.environment ?? { kind: "none" as const };
      const target =
        environment.kind === "target" && scope.sessionKind === "conversation"
          ? scope.executionTargets?.find(
              (t) =>
                t.kind === environment.targetKind &&
                environment.capabilities.every((c) => t.capabilities.includes(c)),
            )
          : undefined;
      const prepare = async (
        nativeCallId: string,
        raw: unknown,
        signal?: AbortSignal,
        recovery = false,
      ) => {
        if (definition.availability === "root" && scope.sessionKind === "subagent")
          throw new Error("tool_unavailable: This Tool belongs to the root conversation");
        if (!workspaceAvailable && (environment.kind === "workspace" || definition.workflowScript))
          throw new Error("workspace_unavailable: this child has no Linux workspace");
        const args = raw as Record<string, unknown>,
          invocationId = toolInvocationId(nativeCallId);
        const script = definition.workflowScript?.(args);
        if (script !== undefined) {
          if (recovery) throw new Error("Workflow execution cannot be recovered");
          return prepareWorkflow(nativeCallId, invocationId, script, signal, definition.name);
        }
        if (ordinary) {
          const current = this.options.catalog
            .read()
            .tools.find((tool) => tool.name === definition.name);
          if (
            !current ||
            !isDeepStrictEqual(current.parameters, definition.parameters) ||
            !isDeepStrictEqual(current.environment, environment) ||
            current.availability !== definition.availability
          )
            throw new Error(
              `tool_unavailable: ${definition.name} was withdrawn or changed before admission`,
            );
        } else if (!isControlToolName(definition.name))
          throw new Error("Invalid control Tool definition");
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
        const bindingId =
          environment.kind === "workspace"
            ? await context.prepareEnvironment()
            : environment.kind === "target"
              ? target
                ? await prepareTarget(target, signal)
                : undefined
              : undefined;
        if (environment.kind === "target" && !bindingId)
          throw new Error("tool_unavailable: This conversation has no matching execution target");
        const anchor = original
          ? original.contextAnchor
          : ordinary
            ? null
            : await this.options.nativeConversations.childAnchor(
                scope.executionReference,
                definition.inheritedContext?.(args) ?? false,
                scope.piSession.conversationId,
              );
        const waiting = new AbortController();
        const deadline =
          environment.kind === "target" ? AbortSignal.timeout(ANDROID_REPLY_TIMEOUT_MS) : undefined;
        const activeSignal = AbortSignal.any([
          waiting.signal,
          ...(signal ? [signal] : []),
          ...(deadline ? [deadline] : []),
        ]);
        const pending = this.options.wait(
          operationId,
          nativeCallId,
          definition.name,
          activeSignal,
          { tenantId: scope.tenantId, runId: scope.runId },
        );
        void pending.result.catch(() => {});
        const command: CandidateToolEffect =
          environment.kind === "target"
            ? {
                target: "executor",
                executionReference: scope.executionReference,
                operationId,
                bindingId: bindingId!,
                toolCallId: invocationId,
                nativeCallId,
                conversationId: scope.piSession.conversationId,
                toolName: definition.name,
                arguments: args,
                occurredAt: new Date().toISOString(),
              }
            : {
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
              };
        return {
          command,
          completed: pending.executionSettled,
          dispose: () => waiting.abort(new Error("Control Tool wait ended")),
          result: async () => {
            try {
              const reply = await pending.result;
              return { ...reply.result, isError: reply.isError };
            } catch (error) {
              if (signal?.aborted) throw signal.reason;
              if (deadline?.aborted && error === deadline.reason) {
                const failure = new ToolExecutionFailure({
                  code: "tool_reply_timeout",
                  effect: "unknown",
                  message:
                    "No final device reply arrived. The action may have happened; inspect the device before repeating it.",
                });
                context.onExecutionUnavailable?.(failure);
                throw failure;
              }
              if (
                environment.kind === "target" &&
                error instanceof ToolExecutionFailure &&
                error.effect === "unknown"
              )
                context.onExecutionUnavailable?.(error);
              throw error;
            }
          },
        };
      };
      return {
        executionPlane: ordinary ? ("platform" as const) : ("orchestration" as const),
        offered:
          definition.availability === "root" && scope.sessionKind === "subagent"
            ? false
            : !workspaceAvailable && (environment.kind === "workspace" || definition.workflowScript)
              ? false
              : environment.kind === "target"
                ? Boolean(target)
                : definition.availability === "child"
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
        } as PreparedAgentTool,
      };
    };
    const native = infrastructureToolDefinitions().map((definition) =>
      createBinding(definition, false),
    );
    let revision: string | undefined;
    let current: readonly TrustedAgentTool[] = native;
    return {
      current: () => {
        const catalog = this.options.catalog.read();
        if (catalog.revision !== revision) {
          current = [
            ...native,
            ...catalog.tools.map((definition) =>
              createBinding(
                {
                  name: definition.name,
                  description: definition.description,
                  parameters: definition.parameters as import("typebox").TSchema,
                  replay: "unsafe",
                  environment: definition.environment,
                  ...(definition.availability ? { availability: definition.availability } : {}),
                },
                true,
              ),
            ),
          ];
          revision = catalog.revision;
        }
        return current;
      },
      subscribe: (listener) => this.options.catalog.subscribe(listener),
    };
  }
}
