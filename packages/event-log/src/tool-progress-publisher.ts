import { Agent, fetch } from "undici";
import {
  TOOL_PROGRESS_PATH,
  ToolPreviewChannel,
  parseToolProgressDelivery,
  type ToolProgressDelivery,
} from "@pi-cloud/protocol";

type Preview = { channel: ToolPreviewChannel; delivery: ToolProgressDelivery; touchedAt: number };
const MAX_PREVIEWS = 256;
const PREVIEW_IDLE_MS = 60_000;

/** Bounded lossy views; coalesce edits, never retain a replay backlog. */
export class ToolProgressPublisher {
  readonly #http = new Agent({ connections: 1 });
  readonly #owners = new Map<number, string>();
  readonly #previews = new Map<string, Preview>();
  readonly #sending = new Map<string, AbortController>();
  readonly #timer: NodeJS.Timeout;
  #closed = false;
  constructor(
    readonly baseUrl: string,
    readonly token: string,
  ) {
    this.#timer = setInterval(() => {
      const deadline = Date.now() - PREVIEW_IDLE_MS;
      for (const [id, preview] of this.#previews) if (preview.touchedAt < deadline) this.forget(id);
      this.flush();
    }, 1000);
    this.#timer.unref();
  }
  update(delivery: ToolProgressDelivery): void {
    if (this.#closed) return;
    try {
      parseToolProgressDelivery(delivery);
    } catch {
      return;
    }
    const id = delivery.progress.operationId;
    let preview = this.#previews.get(id);
    if (!preview) {
      if (this.#previews.size >= MAX_PREVIEWS) this.forget(this.#previews.keys().next().value!);
      preview = { channel: new ToolPreviewChannel(), delivery, touchedAt: Date.now() };
      this.#previews.set(id, preview);
    } else if (
      preview.delivery.tenantId !== delivery.tenantId ||
      preview.delivery.progress.sessionId !== delivery.progress.sessionId ||
      preview.delivery.progress.turnId !== delivery.progress.turnId ||
      preview.delivery.progress.toolCallId !== delivery.progress.toolCallId
    )
      return;
    try {
      if (!preview.channel.accept(delivery.progress.update)) return;
    } catch {
      return;
    }
    preview.delivery = delivery;
    preview.touchedAt = Date.now();
  }
  forget(operationId: string): void {
    this.#previews.delete(operationId);
    this.#sending.get(operationId)?.abort();
  }
  flush(): void {
    if (this.#closed) return;
    for (const [id, preview] of this.#previews) {
      if (this.#sending.has(id)) continue;
      const update = preview.channel.take();
      if (!update) continue;
      const delivery = { ...preview.delivery, progress: { ...preview.delivery.progress, update } };
      const controller = new AbortController();
      this.#sending.set(id, controller);
      void this.#send(delivery, controller.signal, preview).finally(() => {
        this.#sending.delete(id);
      });
    }
  }
  async #send(
    delivery: ToolProgressDelivery,
    signal: AbortSignal,
    preview: Preview,
  ): Promise<void> {
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
      if (response.status === 307 && owner)
        this.#owners.set(delivery.partition, new URL(owner).origin);
      else if (!response.ok) this.#owners.delete(delivery.partition);
      if (!response.ok) preview.channel.resync();
      await response.body?.cancel();
    } catch {
      this.#owners.delete(delivery.partition);
      preview.channel.resync();
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    this.#previews.clear();
    for (const controller of this.#sending.values()) controller.abort();
    await this.#http.destroy();
  }
}
