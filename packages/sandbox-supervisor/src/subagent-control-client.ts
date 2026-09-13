import { randomUUID } from "node:crypto";
import type {
  CandidateSubagentCommand,
  SubagentCommandPublisher,
  SubagentControlRequest,
  SubagentControlResult,
} from "@pi-cloud/protocol";

/** Correlation only. Kafka/PG retain requests/results; this is not another queue. */
export class SubagentControlClient {
  readonly #pending = new Map<
    string,
    {
      lease: string;
      resolve(value: Record<string, unknown>): void;
      reject(error: Error): void;
    }
  >();
  #closed = false;
  constructor(readonly resolvePublisher: (lease: string) => SubagentCommandPublisher | undefined) {}

  async request(input: {
    executionLease: string;
    toolCallId: string;
    workflowId: string;
    request: SubagentControlRequest;
    signal?: AbortSignal;
    onPublished?(): void;
  }): Promise<Record<string, unknown>> {
    if (this.#closed) throw new Error("Subagent control client is closed");
    input.signal?.throwIfAborted();
    const publisher = this.resolvePublisher(input.executionLease);
    if (!publisher) throw new Error("Subagent execution log is unavailable");
    const requestId = randomUUID();
    let fail!: (error: Error) => void;
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      fail = reject;
      this.#pending.set(requestId, { lease: input.executionLease, resolve, reject });
    });
    // Abort/publication can fail before the caller starts waiting for the response.
    void result.catch(() => {});
    const abort = () => fail(new Error("Subagent control request was interrupted"));
    input.signal?.addEventListener("abort", abort, { once: true });
    const command: CandidateSubagentCommand = {
      executionLease: input.executionLease,
      requestId,
      toolCallId: input.toolCallId,
      workflowId: input.workflowId,
      request: input.request,
      occurredAt: new Date().toISOString(),
    };
    try {
      await publisher.publishSubagentCommand(command);
      input.onPublished?.();
      return await result;
    } finally {
      input.signal?.removeEventListener("abort", abort);
      this.#pending.delete(requestId);
    }
  }

  receive(executionLease: string, response: SubagentControlResult): void {
    const pending = this.#pending.get(response.requestId);
    if (!pending) return; // Duplicate delivery or a departed invocation.
    if (pending.lease !== executionLease) throw new Error("Subagent response authority mismatch");
    if (response.ok) pending.resolve(response.result ?? {});
    else pending.reject(new Error(response.error ?? "Subagent command failed"));
  }

  close(): void {
    this.#closed = true;
    for (const pending of this.#pending.values())
      pending.reject(new Error("Subagent host stopped"));
    this.#pending.clear();
  }
}
