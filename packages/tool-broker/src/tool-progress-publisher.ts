import { Agent, fetch } from "undici";
import { TOOL_PROGRESS_PATH, type ToolProgressDelivery } from "@pi-cloud/protocol";

/** Lossy observations: one newest snapshot per invocation, no delivery backlog. */
export class ToolProgressPublisher {
  readonly #http = new Agent({ connections: 1 });
  readonly #owners = new Map<number, string>();
  readonly #pending = new Map<string, ToolProgressDelivery>();
  readonly #sending = new Map<string, AbortController>();
  readonly #timer: NodeJS.Timeout;
  constructor(
    readonly baseUrl: string,
    readonly token: string,
  ) {
    this.#timer = setInterval(() => this.flush(), 1000);
    this.#timer.unref();
  }
  update(delivery: ToolProgressDelivery): void {
    this.#pending.set(delivery.progress.operationId, delivery);
  }
  forget(operationId: string): void {
    this.#pending.delete(operationId);
    this.#sending.get(operationId)?.abort();
  }
  flush(): void {
    for (const [id, delivery] of this.#pending) {
      if (this.#sending.has(id)) continue;
      this.#pending.delete(id);
      const controller = new AbortController();
      this.#sending.set(id, controller);
      void this.#send(delivery, controller.signal).finally(() => this.#sending.delete(id));
    }
  }
  async #send(delivery: ToolProgressDelivery, signal: AbortSignal): Promise<void> {
    try {
      const response = await fetch(
        new URL(TOOL_PROGRESS_PATH, this.#owners.get(delivery.partition) ?? this.baseUrl),
        {
          dispatcher: this.#http,
          method: "POST",
          headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
          body: JSON.stringify(delivery),
          signal: AbortSignal.any([signal, AbortSignal.timeout(1000)]),
          redirect: "manual",
        },
      );
      const owner = response.headers.get("location");
      // Use the new route for the next observation, never retry this snapshot.
      if (response.status === 307 && owner)
        this.#owners.set(delivery.partition, new URL(owner).origin);
      else if (!response.ok) this.#owners.delete(delivery.partition);
      await response.body?.cancel();
    } catch {
      // A lost observation says nothing about execution or final-result delivery.
      this.#owners.delete(delivery.partition);
    }
  }
  async close(): Promise<void> {
    clearInterval(this.#timer);
    this.#pending.clear();
    for (const controller of this.#sending.values()) controller.abort();
    await this.#http.destroy();
  }
}
