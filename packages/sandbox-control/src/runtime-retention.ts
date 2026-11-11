import { randomUUID } from "node:crypto";
import {
  RESOURCE_RETENTION_BATCH_SIZE,
  SESSION_ACTIVITY_FRESH_MS,
  type PhysicalResourceUse,
} from "@pi-cloud/protocol";

export type RuntimeRetentionTarget = Omit<PhysicalResourceUse, "observedAt">;
type Source = { writerId: string; observedAt: number; current(): boolean };
type Pending = { target: RuntimeRetentionTarget; source: Source };
const keyOf = (target: RuntimeRetentionTarget) =>
  JSON.stringify([target.kind, target.tenantId, target.id]);

/** Disposable activity delivery only. PG/resource management owns expiry. */
export class RuntimeRetention {
  readonly #pending = new Map<string, Pending>();
  readonly #lastSent = new Map<string, number>();
  readonly #retired = new Map<string, number>();
  readonly #holds = new Map<
    string,
    { target: RuntimeRetentionTarget; users: number; writerId: string; lastObserved: number }
  >();
  readonly #timer: NodeJS.Timeout;
  #inflight: Promise<void> | undefined;
  #retryAt = 0;
  #scheduled = false;
  #closed = false;
  constructor(
    readonly options: {
      renew(uses: readonly PhysicalResourceUse[]): Promise<unknown>;
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
    return (
      Number.isSafeInteger(at) &&
      at > 0 &&
      at <= this.#now() + 5000 &&
      this.#now() - at <= SESSION_ACTIVITY_FRESH_MS
    );
  }
  retain(target: RuntimeRetentionTarget, source: Source): void {
    if (
      this.#closed ||
      this.#retired.has(source.writerId) ||
      !source.current() ||
      !this.#fresh(source.observedAt)
    )
      return;
    const key = keyOf(target),
      old = this.#pending.get(key);
    if (old && old.source.observedAt >= source.observedAt) return;
    if (!old && this.#pending.size >= 4096) {
      this.options.sample?.("capacity");
      return;
    }
    this.#pending.set(key, { target, source });
    if (!this.#scheduled) {
      this.#scheduled = true;
      queueMicrotask(() => {
        this.#scheduled = false;
        this.flush();
      });
    }
  }
  /** Authorized human connection use, independent of a Session writer/probe. */
  hold(target: RuntimeRetentionTarget): () => void {
    if (this.#closed) throw new Error("Resource activity is closed");
    const key = keyOf(target);
    let entry = this.#holds.get(key);
    if (!entry) {
      if (this.#holds.size >= 4096) throw new Error("Resource activity capacity exceeded");
      entry = { target, users: 0, writerId: randomUUID(), lastObserved: -Infinity };
      this.#holds.set(key, entry);
    }
    entry.users++;
    this.flush();
    const held = entry;
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      if (--held.users === 0 && this.#holds.get(key) === held) {
        this.#holds.delete(key);
      }
    };
  }
  forget(writerId: string): void {
    this.#retired.set(writerId, this.#now());
    for (const [id, value] of this.#pending)
      if (value.source.writerId === writerId) this.#pending.delete(id);
  }
  flush(): void {
    if (this.#closed) return;
    const now = this.#now();
    for (const held of this.#holds.values()) {
      if (now - held.lastObserved < 30000) continue;
      held.lastObserved = now;
      this.retain(held.target, {
        writerId: held.writerId,
        observedAt: now,
        // An observed human use remains valid after disconnect; only future
        // declarations stop. Do not discard a coalesced last-use observation.
        current: () => !this.#closed,
      });
    }
    for (const [writer, at] of this.#retired) if (now - at > 120000) this.#retired.delete(writer);
    if (this.#inflight || now < this.#retryAt) return;
    const selected = new Map<string, Pending>();
    for (const [key, value] of this.#pending) {
      if (!value.source.current() || !this.#fresh(value.source.observedAt)) {
        this.#pending.delete(key);
        continue;
      }
      const last = this.#lastSent.get(key);
      if (last !== undefined && now - last < (this.options.coalesceMs ?? 60000)) continue;
      this.#pending.delete(key);
      if (this.#lastSent.size >= 4096 && !this.#lastSent.has(key))
        this.#lastSent.delete(this.#lastSent.keys().next().value!);
      this.#lastSent.set(key, now);
      selected.set(key, value);
      if (selected.size >= RESOURCE_RETENTION_BATCH_SIZE) break;
    }
    if (!selected.size) return;
    this.#inflight = Promise.resolve()
      .then(() =>
        this.options.renew(
          [...selected.values()].map(({ target, source }) => ({
            ...target,
            observedAt: source.observedAt,
          })),
        ),
      )
      .then(() => {
        this.options.sample?.("recorded");
      })
      .catch(() => {
        this.options.sample?.("unconfirmed");
        this.#retryAt = this.#now() + 5000;
        for (const [key, value] of selected) {
          this.#lastSent.delete(key);
          if (
            this.#closed ||
            this.#retired.has(value.source.writerId) ||
            !value.source.current() ||
            !this.#fresh(value.source.observedAt)
          )
            continue;
          const newer = this.#pending.get(key);
          if (!newer || newer.source.observedAt < value.source.observedAt)
            this.#pending.set(key, value);
        }
      })
      .finally(() => {
        this.#inflight = undefined;
      });
  }
  reset(): void {
    this.#pending.clear();
    this.#lastSent.clear();
    this.#retired.clear();
    this.#retryAt = 0;
  }
  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    this.#holds.clear();
    this.reset();
    await this.#inflight;
  }
}
