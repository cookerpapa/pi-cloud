import type { ServerResponse } from "node:http";
import type { PiCloudMetrics } from "@pi-cloud/observability";
import { ToolBrokerError } from "./sandbox-provider.ts";

export const DEFAULT_TOOL_TRANSPORT_CAPACITY = Object.freeze({
  maximumActiveCommands: 32,
  maximumResultReaders: 128,
  maximumSendingBytes: 32 * 1024 * 1024,
  sendTimeoutMs: 30000,
});
export type ToolDeliveryCapacity = Readonly<{
  maximumResultReaders: number;
  maximumSendingBytes: number;
  sendTimeoutMs: number;
}>;

/** Owns an HTTP delivery, not a Tool execution or the completed-result cache. */
export class ToolResultDeliveryBudget {
  #readers = 0;
  #sendingBytes = 0;
  readonly #limits: ToolDeliveryCapacity;
  readonly #metrics: PiCloudMetrics | undefined;
  constructor(limits: ToolDeliveryCapacity, metrics?: PiCloudMetrics) {
    for (const value of Object.values(limits))
      if (!Number.isSafeInteger(value) || value < 1)
        throw new TypeError("Invalid Tool delivery capacity");
    this.#limits = limits;
    this.#metrics = metrics;
    this.#observe();
  }
  open(response: ServerResponse) {
    if (this.#readers >= this.#limits.maximumResultReaders) {
      this.#metrics?.toolTransportRejected.inc({ reason: "readers" });
      throw new ToolBrokerError(
        "tool_operation_outcome_unknown",
        "Tool result readers are at capacity; execution outcome is not confirmed",
        false,
      );
    }
    this.#readers++;
    this.#observe();
    const controller = new AbortController();
    let closed = false,
      bytes = 0,
      timer: NodeJS.Timeout | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(timer);
      response.off("close", close);
      response.off("finish", close);
      this.#readers--;
      this.#sendingBytes -= bytes;
      this.#observe();
      controller.abort(new Error("Tool result reader disconnected"));
    };
    response.once("close", close);
    response.once("finish", close);
    if (response.destroyed) close();
    return {
      signal: controller.signal,
      close,
      sending: (size: number) => {
        controller.signal.throwIfAborted();
        if (this.#sendingBytes + size > this.#limits.maximumSendingBytes) {
          this.#metrics?.toolTransportRejected.inc({ reason: "response_bytes" });
          throw new ToolBrokerError(
            "tool_operation_outcome_unknown",
            "Tool result delivery is at capacity; the command must not be restarted",
            false,
          );
        }
        bytes = size;
        this.#sendingBytes += size;
        this.#observe();
        timer = setTimeout(() => response.destroy(), this.#limits.sendTimeoutMs);
        timer.unref();
      },
    };
  }
  statistics() {
    return { resultReaders: this.#readers, sendingBytes: this.#sendingBytes };
  }
  #observe() {
    this.#metrics?.toolResultReaders.set(this.#readers);
    this.#metrics?.toolResultSendingBytes.set(this.#sendingBytes);
  }
}
