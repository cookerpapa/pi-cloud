import { randomUUID } from "node:crypto";
import type {
  CandidateControlToolCommand,
  SubagentControlRequest,
  ToolResultPayload,
  ToolReplyWait,
} from "@pi-cloud/protocol";
import { parseSubagentTaskId, prepareSubagentArguments } from "@pi-cloud/protocol";

/** Dynamic workflow host calls reuse the Worker's one boot-scoped reply mailbox. */
export class SubagentControlClient {
  readonly #abort = new AbortController();
  #closed = false;
  constructor(
    readonly native: {
      publishHostCall(taskId: number, command: CandidateControlToolCommand): Promise<void>;
      retireHostCall(reference: string, taskId: number, id: string): Promise<void>;
    },
    readonly replies: {
      topic: string;
      wait(
        id: string,
        callId: string,
        name: string,
        signal: AbortSignal,
      ): ToolReplyWait<ToolResultPayload>;
    },
  ) {}

  async request(input: {
    executionReference: string;
    conversationId: number;
    toolCallId: string;
    request: SubagentControlRequest;
    signal?: AbortSignal;
    onPublished?(): void;
  }): Promise<Record<string, unknown>> {
    if (this.#closed) throw new Error("Subagent control client is closed");
    input.signal?.throwIfAborted();
    const taskId = parseSubagentTaskId(input.toolCallId);
    const request = input.request;
    if (!["run", "status", "wait", "cancel", "send"].includes(request.action))
      throw new Error("Unsupported native workflow hostcall");
    const args =
      request.action === "run"
        ? prepareSubagentArguments({
            action: "run",
            task: request.task,
            context: request.context,
            sandbox: request.sandbox === "none" ? "shared" : request.sandbox,
            ...(request.cwd ? { cwd: request.cwd } : {}),
            ...(request.tools ? { tools: request.tools } : {}),
          })
        : prepareSubagentArguments(request);
    const requestId = randomUUID();
    const waiting = new AbortController();
    const signal = AbortSignal.any([
      this.#abort.signal,
      waiting.signal,
      ...(input.signal ? [input.signal] : []),
    ]);
    const { result } = this.replies.wait(requestId, input.toolCallId, "subagent-control", signal);
    // Abort/publication can fail before the caller starts waiting for the response.
    void result.catch(() => {});
    const command: CandidateControlToolCommand = {
      target: "control",
      executionReference: input.executionReference,
      operationId: requestId,
      toolCallId: input.toolCallId,
      nativeCallId: input.toolCallId,
      conversationId: input.conversationId,
      toolName: "subagent",
      arguments: args,
      replyMode: "hostcall",
      contextAnchor:
        request.action === "run" && request.anchor !== null ? Number(request.anchor) : null,
      ...(request.action === "run" ? { workflowKey: request.key } : {}),
      occurredAt: new Date().toISOString(),
    };
    try {
      await this.native.publishHostCall(taskId, command);
      input.onPublished?.();
      const reply = await result;
      const receipt = reply.result.details as
        | {
            executionReference?: string;
            value?: Record<string, unknown>;
          }
        | undefined;
      if (receipt?.executionReference !== input.executionReference)
        throw new Error("Subagent response authority mismatch");
      await this.native.retireHostCall(input.executionReference, taskId, requestId);
      if (reply.isError)
        throw new Error(
          reply.result.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
        );
      return receipt.value ?? {};
    } catch (error) {
      if (input.signal?.aborted)
        throw new Error("Subagent control request was interrupted", { cause: error });
      throw error;
    } finally {
      waiting.abort(new Error("Subagent reply wait closed"));
    }
  }

  close(): void {
    this.#closed = true;
    this.#abort.abort(new Error("Subagent host stopped"));
  }
}
