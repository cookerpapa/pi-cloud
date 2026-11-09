export type RuntimeRetentionTarget = Readonly<{ id: string; capsule: string }>;
type Source = { writerId: string; observedAt: number; current(): boolean };
/** Disposable delivery/coalescing only. Cube owns the durable expiry clock. */
export class RuntimeRetention {
  readonly #pending = new Map<string, { target: RuntimeRetentionTarget; source: Source }>();
  readonly #lastSent = new Map<string, number>();
  readonly #inflight = new Set<Promise<void>>();
  readonly #retired = new Map<string, number>();
  readonly #timer: NodeJS.Timeout;
  #closed = false;
  constructor(
    readonly options: {
      renew(target: RuntimeRetentionTarget, observedAt: number): Promise<void>;
      clock?: () => number;
      coalesceMs?: number;
      sample?(outcome: string): void;
    },
  ) {
    this.#timer = setInterval(() => this.flush(), 1000);
    this.#timer.unref();
  }
  #now() {
    return this.options.clock?.() ?? Date.now();
  }
  #fresh(at: number) {
    return Number.isFinite(at) && at <= this.#now() + 5000 && this.#now() - at <= 45000;
  }
  retain(target: RuntimeRetentionTarget, source: Source): void {
    if (
      this.#closed ||
      this.#retired.has(source.writerId) ||
      !source.current() ||
      !this.#fresh(source.observedAt)
    )
      return;
    const old = this.#pending.get(target.id);
    if (old && old.source.observedAt >= source.observedAt) return;
    if (!old && this.#pending.size >= 4096) {
      this.options.sample?.("capacity");
      return;
    }
    this.#pending.set(target.id, { target, source });
    this.flush();
  }
  forget(writerId: string): void {
    this.#retired.set(writerId, this.#now());
    for (const [id, pending] of this.#pending)
      if (pending.source.writerId === writerId) this.#pending.delete(id);
  }
  flush(): void {
    if (this.#closed) return;
    for (const [writer, at] of this.#retired)
      if (this.#now() - at > 120_000) this.#retired.delete(writer);
    for (const [key, value] of this.#pending) {
      if (!value.source.current() || !this.#fresh(value.source.observedAt)) {
        this.#pending.delete(key);
        continue;
      }
      if (this.#inflight.size >= 4) break;
      const last = this.#lastSent.get(key);
      if (last !== undefined && this.#now() - last < (this.options.coalesceMs ?? 60000)) continue;
      this.#pending.delete(key);
      if (this.#lastSent.size >= 4096 && !this.#lastSent.has(key))
        this.#lastSent.delete(this.#lastSent.keys().next().value!);
      this.#lastSent.set(key, this.#now());
      const work = this.options
        .renew(value.target, value.source.observedAt)
        .then(() => {
          this.options.sample?.("confirmed");
        })
        .catch(() => {
          this.options.sample?.("unconfirmed");
        })
        .finally(() => this.#inflight.delete(work));
      this.#inflight.add(work);
    }
  }
  reset(): void {
    this.#pending.clear();
    this.#lastSent.clear();
    this.#retired.clear();
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    this.reset();
    await Promise.allSettled(this.#inflight);
  }
}
