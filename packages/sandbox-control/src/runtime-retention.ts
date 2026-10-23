import type { RuntimeKeepalive, RuntimeKeepaliveResource } from "@pi-cloud/protocol";

export type RuntimeRetentionTarget = Readonly<{ id: string; capsule: string }>;
type Source = { writerId: string; observedAt: number; current(): boolean };
/** Disposable delivery/coalescing only. Cube owns the durable expiry clock. */
export class RuntimeRetention {
  readonly #references = new Map<string, Promise<RuntimeRetentionTarget | undefined>>();
  readonly #pending = new Map<string, { target: RuntimeRetentionTarget; source: Source }>();
  readonly #lastSent = new Map<string, number>();
  readonly #inflight = new Set<Promise<void>>();
  readonly #timer: NodeJS.Timeout;
  #generation = 0;
  #closed = false;
  constructor(
    readonly options: {
      resolve(
        scope: RuntimeKeepalive["scope"],
        resource: RuntimeKeepaliveResource,
        observedAt: number,
      ): Promise<RuntimeRetentionTarget | undefined>;
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
  consume(fact: RuntimeKeepalive, current: () => boolean): void {
    const at = Date.parse(fact.occurredAt),
      generation = this.#generation;
    if (this.#closed || !current() || !this.#fresh(at)) return;
    for (const resource of fact.resources) {
      const key = `${fact.scope.tenantId}:${fact.scope.piSessionId}:${fact.scope.writerId}:${resource.workspaceId}:${resource.computeSessionId ?? ""}`;
      let resolution = this.#references.get(key);
      if (!resolution) {
        if (this.#references.size >= 16384) {
          this.options.sample?.("capacity");
          continue;
        }
        resolution = this.options.resolve(fact.scope, resource, at);
        this.#references.set(key, resolution);
      }
      const captured = resolution;
      void resolution
        .then((target) => {
          if (
            !target ||
            this.#closed ||
            generation !== this.#generation ||
            !current() ||
            !this.#fresh(at)
          )
            return;
          const old = this.#pending.get(target.id);
          if (old && old.source.observedAt >= at) return;
          if (!old && this.#pending.size >= 4096) {
            this.options.sample?.("capacity");
            return;
          }
          this.#pending.set(target.id, {
            target,
            source: { writerId: fact.scope.writerId, observedAt: at, current },
          });
          this.flush();
        })
        .catch(() => {
          if (this.#references.get(key) === captured) this.#references.delete(key);
          this.options.sample?.("lookup_failed");
        });
    }
  }
  invalidate(writerId: string): void {
    for (const key of this.#references.keys())
      if (key.includes(`:${writerId}:`)) this.#references.delete(key);
  }
  invalidateSession(tenantId: string, piSessionId: string): void {
    for (const key of this.#references.keys())
      if (key.startsWith(`${tenantId}:${piSessionId}:`)) this.#references.delete(key);
  }
  forget(writerId: string): void {
    this.invalidate(writerId);
    // An already accepted pulse retains its original bounded deadline after
    // settlement. No new pulse from the closed writer will be admitted.
  }
  flush(): void {
    if (this.#closed) return;
    for (const [key, value] of this.#pending) {
      if (!value.source.current() || !this.#fresh(value.source.observedAt)) {
        this.#pending.delete(key);
        continue;
      }
      if (this.#inflight.size >= 4) break;
      const last = this.#lastSent.get(key);
      if (last !== undefined && this.#now() - last < (this.options.coalesceMs ?? 30000)) continue;
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
    this.#generation++;
    this.#references.clear();
    this.#pending.clear();
    this.#lastSent.clear();
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    this.reset();
    await Promise.allSettled(this.#inflight);
  }
}
