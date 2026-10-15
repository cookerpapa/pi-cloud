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
  DurableCommitIndex,
  isControlToolCommand,
  PublicationNotSentError,
  type CandidateToolEffect,
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
  command: CandidateToolEffect;
  result(): Promise<ToolExecutionResult>;
  dispose(): void;
  /** Reply observation only; it does not replace Pi's canonical result. */
  completed(): boolean;
};
type Pending = {
  prepared: PreparedRemoteInvocation;
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
          (isControlToolCommand(prepared.command)
            ? prepared.command.toolName
            : (prepared.command.nativeToolName ?? prepared.command.request.toolName)) !== call.name
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
  preparePublication(commit: DurableSessionCommit): {
    tools: { taskId: number; command: CandidateToolEffect }[];
    cancellations: CandidateToolCancellation[];
    confirmed(): void;
  } {
    const tools: { taskId: number; command: CandidateToolEffect }[] = [];
    const cancellations: CandidateToolCancellation[] = [];
    const terminal: number[] = [];
    const cancelling: Pending[] = [];
    const index = new DurableCommitIndex(commit);
    for (const write of commit.writes) {
      if (write.type !== "task") continue;
      const task = write.value as {
        id: number;
        conversationId: number;
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
        if (!isControlToolCommand(command))
          cancellations.push({
            executionReference: command.executionReference,
            conversationId: task.conversationId,
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
        const intent = durableToolIntent(commit, task.id, index),
          command = pending.prepared.command;
        const matches = isControlToolCommand(command)
          ? command.nativeCallId === intent.callId &&
            isDeepStrictEqual(command.arguments, intent.arguments)
          : command.request.toolCallId === intent.callId &&
            (command.request.operation === "tool.execute"
              ? isDeepStrictEqual(command.request.args, intent.arguments)
              : command.request.script === intent.arguments.script);
        if (!matches)
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
