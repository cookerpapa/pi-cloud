import { Agent, fetch } from "undici";
import {
  EXECUTOR_TARGET_BIND_PATH,
  type ExecuteTurnCommandMessage,
  type ExecutionTargetGrant,
} from "@pi-cloud/protocol";

export class ExecutionTargetClient {
  readonly #http = new Agent();
  constructor(
    readonly baseUrl: string,
    readonly token: string,
  ) {}
  async bind(
    command: ExecuteTurnCommandMessage,
    target: ExecutionTargetGrant,
    signal?: AbortSignal,
  ): Promise<string> {
    const response = await fetch(new URL(EXECUTOR_TARGET_BIND_PATH, this.baseUrl), {
      dispatcher: this.#http,
      method: "POST",
      headers: { authorization: "Bearer " + this.token, "content-type": "application/json" },
      body: JSON.stringify({ executionReference: command.payload.executionReference, target }),
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(15000)])
        : AbortSignal.timeout(15000),
    });
    const body = await response.text();
    if (body.length > 4096 || !response.ok)
      throw new Error("Execution target preparation is unavailable");
    const value = JSON.parse(body);
    if (typeof value.bindingId !== "string" || !/^[a-f0-9-]{36}$/.test(value.bindingId))
      throw new Error("Invalid execution binding");
    return value.bindingId;
  }
  close() {
    return this.#http.close();
  }
}
