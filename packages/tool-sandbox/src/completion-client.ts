import { request as httpsRequest } from "node:https";
import { setTimeout as delay } from "node:timers/promises";
import {
  parseToolCompletionDestination,
  ToolPreviewChannel,
  type ToolCompletionDestination,
  type GuestToolPreview,
} from "@pi-cloud/protocol/guest";

/** Retains one already-finalized result only while delivering it. Network
 * retries never call a Tool. The caller owns execution and scope cleanup. */
export class GuestCompletionClient {
  readonly destination: ToolCompletionDestination;
  readonly #previews = new ToolPreviewChannel();
  #preview: GuestToolPreview | undefined;
  #sending: Promise<void> | undefined;
  #closed = false;
  constructor(
    destination: unknown,
    readonly operationId: string,
  ) {
    this.destination = parseToolCompletionDestination(destination);
  }
  #post(body: Buffer, budgetMs: number): Promise<number> {
    const target = new URL(this.destination.url);
    return new Promise((resolve, reject) => {
      const request = httpsRequest(
        {
          hostname: this.destination.address,
          port: target.port || 443,
          servername: target.hostname,
          ca: this.destination.ca,
          path: target.pathname,
          method: "POST",
          headers: {
            host: target.host,
            authorization: `Bearer ${this.destination.capability}`,
            "content-type": "application/json",
            "content-length": body.byteLength,
          },
          signal: AbortSignal.timeout(Math.max(1, budgetMs)),
        },
        (response) => {
          response.resume();
          response.once("end", () => resolve(response.statusCode ?? 503));
        },
      );
      request.once("error", reject);
      request.end(body);
    });
  }
  progress(preview: GuestToolPreview): void {
    if (this.#closed || preview.operationId !== this.operationId) return;
    this.#preview = preview;
    this.#previews.accept(preview.update);
    this.#flush();
  }
  #flush(): void {
    if (this.#closed || this.#sending || !this.#preview) return;
    const update = this.#previews.take();
    if (!update) return;
    const body = Buffer.from(
      JSON.stringify({
        kind: "progress",
        operationId: this.operationId,
        output: { ...this.#preview, update },
      }),
    );
    this.#sending = this.#post(body, 2000)
      .then(
        (status) => {
          if (status !== 204) this.#previews.resync();
        },
        () => {
          this.#previews.resync();
        },
      )
      .finally(() => {
        this.#sending = undefined;
      });
    // A later update sends the latest tail; failure never spins or blocks a Tool.
  }
  async complete(output: unknown): Promise<void> {
    this.#closed = true;
    await this.#sending;
    const body = Buffer.from(
      JSON.stringify({ kind: "result", operationId: this.operationId, output }),
    );
    if (body.length > 64 * 1024 * 1024 + 16384)
      throw new Error("Guest completion exceeded its bound");
    let attempt = 0;
    while (Date.now() < this.destination.expiresAt) {
      const remaining = this.destination.expiresAt - Date.now();
      const status = await this.#post(body, Math.min(30_000, remaining)).catch(() => 503);
      if (status === 204) return;
      if ([400, 401, 403, 409, 413].includes(status))
        throw new Error("Guest completion was refused");
      await delay(
        Math.min(
          5000,
          250 * 2 ** Math.min(attempt++, 4),
          Math.max(0, this.destination.expiresAt - Date.now()),
        ),
      );
    }
    throw new Error("Guest completion delivery expired");
  }
}
