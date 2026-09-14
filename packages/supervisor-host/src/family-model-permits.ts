type Waiter = {
  resolve(release: () => void): void;
  reject(error: unknown): void;
  signal?: AbortSignal;
  abort: () => void;
  queuedAt: number;
};
type Family = { active: number; queue: Waiter[] };

/** Local request admission, not a durable task queue. Never held across Tools. */
export class FamilyModelPermits {
  readonly #families = new Map<string, Family>();
  readonly #ready: string[] = [];
  #active = 0;
  #closed = false;
  constructor(
    readonly options: {
      maximum: number;
      perFamily: number;
      onChange?: (sample: { active: number; waiting: number }) => void;
      onWait?: (milliseconds: number) => void;
    },
  ) {
    if (
      !Number.isSafeInteger(options.maximum) ||
      options.maximum < 1 ||
      !Number.isSafeInteger(options.perFamily) ||
      options.perFamily < 1 ||
      options.perFamily > options.maximum
    )
      throw new TypeError("Invalid family model concurrency");
  }
  acquire(key: string, signal?: AbortSignal): Promise<() => void> {
    if (this.#closed) return Promise.reject(new Error("Worker model admission is closed"));
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      let family = this.#families.get(key);
      if (!family) {
        family = { active: 0, queue: [] };
        this.#families.set(key, family);
      }
      const waiter: Waiter = {
        resolve,
        reject,
        queuedAt: performance.now(),
        ...(signal ? { signal } : {}),
        abort: () => {
          const index = family!.queue.indexOf(waiter);
          if (index < 0) return;
          family!.queue.splice(index, 1);
          reject(signal?.reason ?? new Error("Model admission cancelled"));
          this.#prune(key, family!);
          this.#drain();
        },
      };
      if (family.queue.length === 0) this.#ready.push(key);
      family.queue.push(waiter);
      signal?.addEventListener("abort", waiter.abort, { once: true });
      this.#drain();
    });
  }
  #prune(key: string, family: Family): void {
    if (family.queue.length === 0) {
      const index = this.#ready.indexOf(key);
      if (index >= 0) this.#ready.splice(index, 1);
    }
    if (family.active === 0 && family.queue.length === 0) this.#families.delete(key);
  }
  #drain(): void {
    let skipped = 0;
    while (
      !this.#closed &&
      this.#active < this.options.maximum &&
      this.#ready.length &&
      skipped < this.#ready.length
    ) {
      const key = this.#ready.shift()!,
        family = this.#families.get(key)!;
      if (family.active >= this.options.perFamily) {
        this.#ready.push(key);
        skipped++;
        continue;
      }
      skipped = 0;
      const waiter = family.queue.shift()!;
      if (family.queue.length) this.#ready.push(key);
      waiter.signal?.removeEventListener("abort", waiter.abort);
      family.active++;
      this.#active++;
      this.options.onWait?.(performance.now() - waiter.queuedAt);
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        family.active--;
        this.#active--;
        this.#prune(key, family);
        this.#drain();
      });
    }
    this.options.onChange?.({
      active: this.#active,
      waiting: [...this.#families.values()].reduce((n, f) => n + f.queue.length, 0),
    });
  }
  close(): void {
    this.#closed = true;
    for (const [key, family] of this.#families) {
      for (const waiter of family.queue) {
        waiter.signal?.removeEventListener("abort", waiter.abort);
        waiter.reject(new Error("Worker model admission closed"));
      }
      family.queue.length = 0;
      this.#prune(key, family);
    }
    this.#ready.length = 0;
    this.#drain();
  }
}
