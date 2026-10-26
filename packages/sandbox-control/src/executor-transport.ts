import { Agent, fetch } from "undici";
import {
  EXECUTOR_OPERATIONS_PATH,
  EXECUTOR_BINDING_PATH,
  type ExecutorBinding,
  type ExecutorCancellation,
  type ExecutorOperation,
  type ToolExecutionFailureData,
} from "@pi-cloud/protocol";

export type ExecutorStatus = {
  targetId: string;
  bootId: string;
  ready: boolean;
  capabilities: string[];
};
export class ExecutorTransportFailure extends Error {
  constructor(readonly failure: ToolExecutionFailureData) {
    super(failure.message);
  }
}
/** Execution transport, separate from VM allocation/Workspace lifecycle. The
 * endpoint is server-owned metadata and never accepted from a Tool's arguments. */
export interface ExecutorTransport {
  inspect(endpoint: string, signal?: AbortSignal): Promise<ExecutorStatus>;
  submit(endpoint: string, operation: ExecutorOperation, signal?: AbortSignal): Promise<void>;
  cancel(endpoint: string, request: ExecutorCancellation, signal?: AbortSignal): Promise<void>;
  revoke(endpoint: string, binding: ExecutorBinding, signal?: AbortSignal): Promise<void>;
  screenshot(endpoint: string, signal?: AbortSignal): Promise<Buffer>;
  close(): Promise<void>;
}
export class HttpExecutorTransport implements ExecutorTransport {
  readonly #http = new Agent();
  constructor(readonly token: string) {}
  async #request(
    endpoint: string,
    path: string,
    method: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const url = new URL(endpoint);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      throw new Error("Invalid executor endpoint");
    const timeout = path === "/screen" ? 30000 : 5000;
    let response;
    try {
      response = await fetch(new URL(path, url), {
        method,
        dispatcher: this.#http,
        headers: { authorization: "Bearer " + this.token, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(timeout)])
          : AbortSignal.timeout(timeout),
      });
    } catch {
      throw new ExecutorTransportFailure({
        code: "executor_handoff_unconfirmed",
        effect: "unknown",
        message: "Device handoff was not confirmed; it was not retried.",
      });
    }
    const chunks: Buffer[] = [];
    let length = 0;
    if (response.body)
      for await (const part of response.body) {
        length += part.length;
        if (length > 64 * 1024 * 1024) throw new Error("Executor response exceeds its boundary");
        chunks.push(Buffer.from(part));
      }
    const bytes = Buffer.concat(chunks);
    if (!response.ok) {
      let value;
      try {
        value = JSON.parse(bytes.toString());
      } catch {}
      if (value?.error?.code && ["not_started", "unknown"].includes(value.error.effect))
        throw new ExecutorTransportFailure({
          code: value.error.code,
          effect: value.error.effect,
          message: "The device rejected this delivery: " + value.error.code,
        });
      throw new ExecutorTransportFailure({
        code: "executor_handoff_unconfirmed",
        effect: "unknown",
        message: "Device handoff was not confirmed; inspect its state before repeating the action.",
      });
    }
    return bytes;
  }
  async inspect(endpoint: string, signal?: AbortSignal): Promise<ExecutorStatus> {
    const value = JSON.parse(
      (await this.#request(endpoint, "/health/ready", "GET", undefined, signal)).toString(),
    );
    if (
      typeof value.targetId !== "string" ||
      typeof value.bootId !== "string" ||
      !Array.isArray(value.capabilities) ||
      value.ready !== true
    )
      throw new Error("Executor is not ready");
    return value;
  }
  async submit(endpoint: string, operation: ExecutorOperation, signal?: AbortSignal) {
    const response = JSON.parse(
      (
        await this.#request(endpoint, EXECUTOR_OPERATIONS_PATH, "POST", operation, signal)
      ).toString(),
    );
    if (response.accepted !== true)
      throw new ExecutorTransportFailure({
        code: "executor_handoff_unconfirmed",
        effect: "unknown",
        message: "Device admission was not confirmed.",
      });
  }
  async cancel(endpoint: string, value: ExecutorCancellation, signal?: AbortSignal) {
    await this.#request(endpoint, EXECUTOR_OPERATIONS_PATH + "/cancel", "POST", value, signal);
  }
  async revoke(endpoint: string, binding: ExecutorBinding, signal?: AbortSignal) {
    await this.#request(endpoint, EXECUTOR_BINDING_PATH + "/close", "POST", binding, signal);
  }
  screenshot(endpoint: string, signal?: AbortSignal) {
    return this.#request(endpoint, "/screen", "GET", undefined, signal);
  }
  close() {
    return this.#http.close();
  }
}
