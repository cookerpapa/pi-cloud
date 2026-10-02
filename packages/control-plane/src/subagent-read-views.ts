/** Disposable Session-local read results. Admission and mutations never use
 * this cache as authority. Epochs discard late reads after change or handoff. */
export class SubagentReadViews {
  readonly #epochs = new Map<string, symbol>();
  readonly #values = new Map<string, { epoch: symbol; value: unknown; bytes: number }>();
  readonly #pending = new Map<string, { epoch: symbol; promise: Promise<unknown> }>();
  #bytes = 0;
  #loading = 0;
  constructor(
    readonly maximumEntries = 4096,
    readonly maximumBytes = 32 * 1024 * 1024,
  ) {}

  reset(): void {
    this.#epochs.clear();
    this.#values.clear();
    this.#bytes = 0;
    this.#pending.clear();
  }
  invalidate(family: string): void {
    if (this.#epochs.size >= this.maximumEntries && !this.#epochs.has(family)) this.reset();
    this.#epochs.set(family, Symbol("subagent-view"));
    const prefix = `${family}\0`;
    for (const key of this.#values.keys()) if (key.startsWith(prefix)) this.#remove(key);
  }
  #remove(key: string): void {
    const old = this.#values.get(key);
    if (old) this.#bytes -= old.bytes;
    this.#values.delete(key);
  }
  async read<T>(family: string, name: string, load: () => Promise<T>): Promise<T> {
    if (!this.#epochs.has(family)) this.invalidate(family);
    const epoch = this.#epochs.get(family)!,
      key = `${family}\0${name}`;
    const cached = this.#values.get(key);
    if (cached?.epoch === epoch) return cached.value as T;
    const running = this.#pending.get(key);
    if (running?.epoch === epoch) return (await running.promise) as T;
    if (this.#loading >= this.maximumEntries)
      throw Object.assign(new Error("Subagent read view capacity exceeded"), { retryable: true });
    this.#loading++;
    const pending = {
      epoch,
      promise: Promise.resolve()
        .then(load)
        .then((value) => {
          if (this.#epochs.get(family) === epoch) {
            const bytes = Buffer.byteLength(JSON.stringify(value) ?? "");
            this.#remove(key);
            while (
              this.#values.size &&
              (this.#values.size >= this.maximumEntries || this.#bytes + bytes > this.maximumBytes)
            )
              this.#remove(this.#values.keys().next().value!);
            if (bytes <= this.maximumBytes) {
              this.#values.set(key, { epoch, value, bytes });
              this.#bytes += bytes;
            }
          }
          return value;
        })
        .finally(() => {
          this.#loading--;
          if (this.#pending.get(key) === pending) this.#pending.delete(key);
        }),
    };
    this.#pending.set(key, pending);
    return pending.promise;
  }
}
