import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import { createInterface } from "node:readline";
import type { ToolSandboxOperationRequest, ToolSandboxOperationResponse } from "@pi-cloud/protocol";

export type WorkflowFrame = {
  type: "call";
  id: number;
  method: string;
  args: Record<string, unknown>;
};
type Channel = {
  activationId: string;
  stream: Duplex;
  calls: Map<number, WorkflowFrame>;
  peer?: (frame: WorkflowFrame) => void;
};
export { TOOL_WORKFLOW_PATH } from "@pi-cloud/protocol";

/** Active duplex invocation transport, with no credentials or authority in the guest. */
export class WorkflowChannels {
  readonly #channels = new Map<string, Channel>();
  readonly #changed = new EventEmitter();
  constructor() {
    this.#changed.setMaxListeners(0);
  }

  async run(
    request: Extract<ToolSandboxOperationRequest, { operation: "workflow.exec" }>,
    stream: Duplex,
    signal: AbortSignal,
    onProgress?: (value: unknown) => Promise<void>,
  ): Promise<ToolSandboxOperationResponse> {
    const channel: Channel = { activationId: request.activationId, stream, calls: new Map() };
    this.#channels.set(request.operationId, channel);
    this.#changed.emit(request.operationId);
    const deadline = setTimeout(
      () => stream.destroy(new Error("Workflow deadline exceeded")),
      request.timeoutMs,
    );
    const abort = () => stream.destroy(new Error("Workflow cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    // Bound a malicious unterminated frame before readline materializes it.
    let lineBytes = 0;
    stream.on("data", (chunk: Buffer) => {
      for (const part of chunk.toString("utf8").split(/(?<=\n)/)) {
        lineBytes += Buffer.byteLength(part);
        if (lineBytes > 2 * 1024 * 1024) stream.destroy(new Error("Workflow frame is too large"));
        if (part.endsWith("\n")) lineBytes = 0;
      }
    });
    try {
      for await (const line of lines) {
        const frame = JSON.parse(line);
        if (frame.type === "complete")
          return {
            toolBrokerProtocolVersion: 1,
            type: "tool_sandbox.operation_result",
            activationId: request.activationId,
            operationId: request.operationId,
            operation: "workflow.exec",
            ok: frame.ok === true,
            value: frame.value ?? null,
            ...(frame.ok === true ? {} : { error: String(frame.error ?? "Workflow failed") }),
          };
        if (frame.type === "call") {
          if (
            !Number.isSafeInteger(frame.id) ||
            channel.calls.has(frame.id) ||
            channel.calls.size >= 64
          )
            throw new Error("Invalid or excessive workflow request");
          channel.calls.set(frame.id, frame);
          channel.peer?.(frame);
        } else if (frame.type === "progress") await onProgress?.(frame.value);
        else throw new Error("Unknown workflow frame");
      }
      throw new Error("Workflow process ended without a result");
    } finally {
      clearTimeout(deadline);
      signal.removeEventListener("abort", abort);
      // Destroying a duplex can report its final abort after readline detaches.
      // Execution errors have already reached the iterator/result above.
      stream.on("error", () => {});
      lines.close();
      this.#channels.delete(request.operationId);
      stream.destroy();
    }
  }

  async attach(
    activationId: string,
    operationId: string,
    peer: (frame: WorkflowFrame) => void,
    signal: AbortSignal,
  ): Promise<{
    respond(frame: { id: number; ok: boolean; value?: unknown; error?: string }): void;
    close(): void;
  }> {
    while (!this.#channels.has(operationId)) {
      signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const changed = () => {
          cleanup();
          resolve();
        };
        const abort = () => {
          cleanup();
          reject(signal.reason);
        };
        const cleanup = () => {
          this.#changed.off(operationId, changed);
          signal.removeEventListener("abort", abort);
        };
        this.#changed.once(operationId, changed);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
    const channel = this.#channels.get(operationId)!;
    if (channel.activationId !== activationId)
      throw new Error("Workflow belongs to another Tool binding");
    if (channel.peer) throw new Error("Workflow already has an attached owner");
    channel.peer = peer;
    for (const frame of channel.calls.values()) peer(frame);
    return {
      respond(frame) {
        if (!channel.calls.delete(frame.id)) throw new Error("Unmatched workflow response");
        channel.stream.write(JSON.stringify(frame) + "\n");
      },
      close() {
        delete channel.peer;
        channel.stream.destroy(new Error("Workflow owner disconnected"));
      },
    };
  }
}
