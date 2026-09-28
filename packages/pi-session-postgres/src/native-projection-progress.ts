/** Disposable progress shared by one physical writer. It is never an authority
 * or a durable receipt: each waiter still checks the current owner. */
export class NativeProjectionProgress {
  #through: number;
  #pending: Promise<void> | undefined;
  #nextReadAt = 0;
  #waiters = 0;

  constructor(
    readonly options: {
      initialThrough: number;
      assertCurrent(): Promise<void>;
      read(): Promise<number>;
      observe?(stage: "projection_wait" | "projection_read", durationMs: number): void;
    },
  ) {
    this.#through = options.initialThrough;
  }

  async wait(through: number, signal: AbortSignal): Promise<void> {
    const started = performance.now();
    this.#waiters++;
    try {
      signal.throwIfAborted();
      if (!Number.isSafeInteger(through) || through < 0)
        throw new Error("Invalid native projection target");
      await abortable(this.options.assertCurrent(), signal);
      while (this.#through < through) {
        await abortable(this.#read(), signal);
      }
      signal.throwIfAborted();
    } finally {
      this.#waiters--;
      this.#observe("projection_wait", started);
    }
  }

  #read(): Promise<void> {
    if (this.#pending) return this.#pending;
    const pending = (async () => {
      const delay = this.#nextReadAt - performance.now();
      if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
      if (!this.#waiters) return;
      await this.options.assertCurrent();
      const started = performance.now();
      try {
        const through = await this.options.read();
        if (!Number.isSafeInteger(through) || through < this.#through)
          throw new Error("Native projection position regressed");
        this.#through = through;
      } finally {
        this.#nextReadAt = performance.now() + 25;
        this.#observe("projection_read", started);
      }
    })().finally(() => {
      if (this.#pending === pending) this.#pending = undefined;
    });
    // All waiters can cancel while a shared read is still in flight.
    void pending.catch(() => {});
    this.#pending = pending;
    return pending;
  }

  #observe(stage: "projection_wait" | "projection_read", started: number) {
    try {
      this.options.observe?.(stage, performance.now() - started);
    } catch {
      /* Observation cannot change the read/ownership outcome. */
    }
  }
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    void pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
