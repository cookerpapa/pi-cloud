export const MODEL_EVENT_IDLE_MS = 300_000;
export const MODEL_RETRY_COUNT = 5;

/** Provider callbacks already carry decoded frames. Transport comments/bytes
 * never reach this predicate, and malformed objects cannot renew the wait. */
export function isModelStreamEvent(event: unknown): boolean {
  return (
    typeof event === "object" &&
    event !== null &&
    "type" in event &&
    typeof event.type === "string" &&
    (event.type.startsWith("response.") ||
      event.type === "error" ||
      event.type === "codex.rate_limits")
  );
}

export class ModelEventWait {
  #timer: NodeJS.Timeout | undefined;
  #closed = false;
  expired = false;
  readonly message: string;
  constructor(
    readonly milliseconds: number,
    readonly expire: () => void,
  ) {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 1)
      throw new TypeError("Invalid model event inactivity timeout");
    this.message = `Model response event idle timeout after ${milliseconds}ms`;
    this.touch();
  }
  touch(): void {
    if (this.expired || this.#closed) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.expired = true;
      this.expire();
    }, this.milliseconds);
    this.#timer.unref();
  }
  close(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
