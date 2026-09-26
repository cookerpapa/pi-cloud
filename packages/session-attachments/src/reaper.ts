import type { PostgresImageAttachmentStore } from "./store.ts";

export class ImageAttachmentReaper {
  readonly #timer: NodeJS.Timeout;
  #pending: Promise<unknown> | undefined;
  readonly #abort = new AbortController();
  constructor(
    store: Pick<PostgresImageAttachmentStore, "reap">,
    onError: () => void,
    intervalMs = 60_000,
  ) {
    this.#timer = setInterval(() => {
      if (!this.#pending)
        this.#pending = store
          .reap(undefined, this.#abort.signal)
          .catch(() => {
            if (!this.#abort.signal.aborted) onError();
          })
          .finally(() => {
            this.#pending = undefined;
          });
    }, intervalMs);
    this.#timer.unref();
  }
  async close() {
    clearInterval(this.#timer);
    this.#abort.abort(new Error("Image cleanup stopped"));
    await this.#pending;
  }
}
