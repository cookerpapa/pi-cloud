export type RunClaimReadinessMonitorOptions = Readonly<{
  check: () => Promise<void>;
  intervalMs?: number;
}>;

export class RunClaimReadinessMonitor {
  readonly #check: () => Promise<void>;
  readonly #intervalMs: number;
  #timer: NodeJS.Timeout | undefined;
  #refreshing: Promise<void> | undefined;
  #ready = false;
  #closed = false;

  constructor(options: RunClaimReadinessMonitorOptions) {
    this.#check = options.check;
    this.#intervalMs = options.intervalMs ?? 1_000;
    if (!Number.isSafeInteger(this.#intervalMs) || this.#intervalMs < 100) {
      throw new TypeError("Run claim readiness interval must be at least 100ms");
    }
  }

  get ready(): boolean {
    return !this.#closed && this.#ready;
  }

  async start(): Promise<void> {
    if (this.#closed || this.#timer !== undefined) {
      throw new Error("Run claim readiness monitor cannot be started");
    }
    await this.#refresh();
    this.#timer = setInterval(() => void this.#refresh(), this.#intervalMs);
    this.#timer.unref();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#ready = false;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async #refresh(): Promise<void> {
    if (this.#closed) return;
    if (this.#refreshing === undefined) {
      const refreshing = this.#check()
        .then(() => {
          if (!this.#closed) this.#ready = true;
        })
        .catch(() => {
          this.#ready = false;
        })
        .finally(() => {
          if (this.#refreshing === refreshing) this.#refreshing = undefined;
        });
      this.#refreshing = refreshing;
    }
    await this.#refreshing;
  }
}
