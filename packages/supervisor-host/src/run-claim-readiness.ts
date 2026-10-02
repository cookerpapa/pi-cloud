import type { PublicationAvailability } from "@pi-cloud/protocol";
export type RunClaimReadinessMonitorOptions = Readonly<{
  check: () => Promise<PublicationAvailability>;
  intervalMs?: number;
}>;

export class RunClaimReadinessMonitor {
  readonly #check: () => Promise<PublicationAvailability>;
  readonly #intervalMs: number;
  #timer: NodeJS.Timeout | undefined;
  #refreshing: Promise<void> | undefined;
  #availability: PublicationAvailability | undefined;
  #freshUntil = 0;
  #closed = false;

  constructor(options: RunClaimReadinessMonitorOptions) {
    this.#check = options.check;
    this.#intervalMs = options.intervalMs ?? 1_000;
    if (!Number.isSafeInteger(this.#intervalMs) || this.#intervalMs < 100) {
      throw new TypeError("Run claim readiness interval must be at least 100ms");
    }
  }

  get ready(): boolean {
    return this.publicationAvailability !== undefined;
  }

  get publicationAvailability(): PublicationAvailability | undefined {
    return !this.#closed &&
      performance.now() < this.#freshUntil &&
      this.#availability?.partitions.length
      ? this.#availability
      : undefined;
  }

  async start(): Promise<void> {
    if (this.#closed || this.#timer !== undefined) {
      throw new Error("Run claim readiness monitor cannot be started");
    }
    await this.#refresh();
    if (this.#closed) return;
    this.#timer = setInterval(() => void this.#refresh(), this.#intervalMs);
    this.#timer.unref();
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#availability = undefined;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async #refresh(): Promise<void> {
    if (this.#closed) return;
    if (this.#refreshing === undefined) {
      const refreshing = this.#check()
        .then((availability) => {
          if (!this.#closed) {
            this.#availability = availability;
            this.#freshUntil = performance.now() + this.#intervalMs * 3;
          }
        })
        .catch(() => {
          this.#availability = undefined;
        })
        .finally(() => {
          if (this.#refreshing === refreshing) this.#refreshing = undefined;
        });
      this.#refreshing = refreshing;
    }
    await this.#refreshing;
  }
}
