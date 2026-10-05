import { isDeepStrictEqual } from "node:util";
import {
  ToolTask,
  hook,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import {
  durableToolIntent,
  PublicationNotSentError,
  type CandidateToolCommand,
  type CandidateToolCancellation,
  type DurableSessionCommit,
} from "@pi-cloud/protocol";

export type RemoteInvocation = {
  taskId: number;
  conversationId: number;
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  context: Context;
};
export type PreparedRemoteInvocation = {
  command: CandidateToolCommand;
  result(): Promise<ToolExecutionResult>;
  dispose(): void;
  /** Reply observation only; it does not replace Pi's canonical result. */
  completed(): boolean;
};
export type TrackedWorkflowOperation = Pick<
  PreparedRemoteInvocation,
  "command" | "completed" | "dispose"
>;
type Pending = {
  prepared: TrackedWorkflowOperation & Partial<Pick<PreparedRemoteInvocation, "result">>;
  dispatched: boolean;
  cancelled: boolean;
};

/** Fixed remote Tools retain Pi's own validation and task state machine. Only
 * the execution handoff and ordered cancellation are cloud-specific. Register
 * this hook after code-owned argument/policy hooks; no user hooks are loaded. */
export class DurableRemoteTools {
  readonly #pending = new Map<number, Pending>();
  readonly definitions: readonly ToolRegistration[];
  readonly hook;
  constructor(options: {
    definitions: readonly Omit<ToolRegistration, "execute" | "replay">[];
    prepare(invocation: RemoteInvocation): Promise<PreparedRemoteInvocation>;
  }) {
    const names = new Set(options.definitions.map((tool) => tool.name));
    this.hook = hook(ToolTask, {
      beforeTool: async (call, api, context) => {
        if (!names.has(call.name)) return;
        const prepared = await options.prepare({
          taskId: api.taskId,
          conversationId: api.conversationId,
          callId: call.id,
          toolName: call.name,
          args: call.arguments,
          context,
        });
        if (
          prepared.command.toolCallId !== `task:${api.taskId}` ||
          prepared.command.request.toolName !== call.name
        ) {
          prepared.dispose();
          throw new Error("Remote Tool preparation changed its native identity");
        }
        if (context.abortSignal?.aborted) {
          prepared.dispose();
          context.abortSignal.throwIfAborted();
        }
        const previous = this.#pending.get(api.taskId);
        if (previous) {
          prepared.dispose();
          throw new Error("Remote invocation was prepared twice");
        }
        this.#pending.set(api.taskId, { prepared, dispatched: false, cancelled: false });
        return undefined;
      },
    });
    this.definitions = options.definitions.map((definition) => ({
      ...definition,
      replay: "unsafe",
      execute: async (_args, api) => {
        const pending = this.#pending.get(api.taskId);
        if (!pending?.dispatched || !pending.prepared.result)
          throw new Error("Remote Tool has no acknowledged execution intent");
        return pending.prepared.result();
      },
    }));
  }
  /** Workflow commands enter the same execution writer synchronously before
   * registration. Native abort can now co-commit their operation cancellation,
   * even while the command ACK or guest completion is still pending. */
  trackWorkflow(operation: TrackedWorkflowOperation): void {
    const match = /^task:([1-9][0-9]*)$/.exec(operation.command.toolCallId);
    if (!match || operation.command.request.operation !== "workflow.exec")
      throw new Error("Workflow cancellation requires its native Tool task identity");
    const taskId = Number(match[1]);
    if (!Number.isSafeInteger(taskId) || this.#pending.has(taskId))
      throw new Error("Workflow operation is already registered");
    this.#pending.set(taskId, { prepared: operation, dispatched: true, cancelled: false });
  }
  preparePublication(commit: DurableSessionCommit): {
    tools: { taskId: number; command: CandidateToolCommand }[];
    cancellations: CandidateToolCancellation[];
    confirmed(): void;
  } {
    const tools: { taskId: number; command: CandidateToolCommand }[] = [];
    const cancellations: CandidateToolCancellation[] = [];
    const terminal: number[] = [];
    const cancelling: Pending[] = [];
    for (const write of commit.writes) {
      if (write.type !== "task") continue;
      const task = write.value as {
        id: number;
        kind: string;
        abortRequested: boolean;
        state: { status: string; checkpoint?: { phase: string } };
      };
      const pending = this.#pending.get(task.id);
      if (!pending || task.kind !== "pi.tool") continue;
      if (
        task.abortRequested &&
        pending.dispatched &&
        !pending.cancelled &&
        !pending.prepared.completed()
      ) {
        const command = pending.prepared.command;
        cancellations.push({
          executionReference: command.executionReference,
          activationId: command.request.activationId,
          operationId: command.request.operationId,
          occurredAt: new Date().toISOString(),
        });
        cancelling.push(pending);
      }
      if (
        !task.abortRequested &&
        task.state.checkpoint?.phase === "execute" &&
        !pending.dispatched
      ) {
        const intent = durableToolIntent(commit, task.id),
          command = pending.prepared.command;
        if (
          command.request.operation !== "tool.execute" ||
          command.request.toolCallId !== intent.callId ||
          !isDeepStrictEqual(command.request.args, intent.arguments)
        )
          throw new PublicationNotSentError(
            "Remote command differs from Pi's final validated intent",
          );
        tools.push({ taskId: task.id, command });
      }
      if (task.state.status === "terminal") terminal.push(task.id);
    }
    return {
      tools,
      cancellations,
      confirmed: () => {
        for (const { taskId } of tools) this.#pending.get(taskId)!.dispatched = true;
        for (const pending of cancelling) pending.cancelled = true;
        for (const taskId of terminal) {
          this.#pending.get(taskId)?.prepared.dispose();
          this.#pending.delete(taskId);
        }
      },
    };
  }
  close(): void {
    for (const pending of this.#pending.values()) pending.prepared.dispose();
    this.#pending.clear();
  }
}
