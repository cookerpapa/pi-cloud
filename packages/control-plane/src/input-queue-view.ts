import type { InputQueueResource, SessionControlChange } from "@pi-cloud/protocol";

const key = (tenant: string, session: string) => `${tenant}:${session}`;
type Cached = { tenant: string; value: InputQueueResource; bytes: number };
type Refresh = {
  tenant: string;
  session: string;
  version: number;
  current(): boolean;
  generation: number;
};

/** Disposable watched pages; native/control wakes never own an execution or block projection. */
export class InputQueueView {
  readonly #queues = new Map<string, Cached>();
  readonly #pending = new Map<string, Refresh>();
  readonly #active = new Map<string, Promise<void>>();
  #bytes = 0;
  #generation = 0;
  #version = 0;
  #closed = false;
  constructor(
    readonly options: {
      read(tenant: string, session: string): Promise<InputQueueResource>;
      watched(tenant: string, session: string): boolean;
      publish(tenant: string, queue: InputQueueResource): void;
      unavailable(tenant: string, session: string): void;
      onError?(): void;
      maximumBytes?: number;
      maximumQueues?: number;
      concurrency?: number;
    },
  ) {}
  reset(): void {
    this.#generation++;
    this.#queues.clear();
    this.#pending.clear();
    this.#bytes = 0;
  }
  #remove(id: string): void {
    const old = this.#queues.get(id);
    if (old) this.#bytes -= old.bytes;
    this.#queues.delete(id);
  }
  current(tenant: string, session: string): InputQueueResource | undefined {
    return this.#queues.get(key(tenant, session))?.value;
  }
  consume(change: SessionControlChange, current: () => boolean): void {
    if (change.entity === "input_queue")
      this.notify(change.scope.tenantId, change.entityId, current);
  }
  notify(tenant: string, session: string, current: () => boolean): void {
    if (this.#closed || !current()) return;
    for (const [id, cached] of this.#queues)
      if (!this.options.watched(cached.tenant, cached.value.sessionId)) this.#remove(id);
    if (!this.options.watched(tenant, session)) return;
    const id = key(tenant, session);
    if (!this.#pending.has(id) && this.#pending.size >= (this.options.maximumQueues ?? 256)) {
      this.#remove(id);
      this.options.unavailable(tenant, session);
      return;
    }
    this.#pending.set(id, {
      tenant,
      session,
      current,
      generation: this.#generation,
      version: ++this.#version,
    });
    this.#pump();
  }
  #valid(refresh: Refresh): boolean {
    return !this.#closed && refresh.generation === this.#generation && refresh.current();
  }
  #pump(): void {
    if (this.#closed) return;
    for (const [id, refresh] of this.#pending) {
      if (this.#active.size >= (this.options.concurrency ?? 2)) break;
      if (this.#active.has(id)) continue;
      this.#pending.delete(id);
      const task = Promise.resolve()
        .then(() => {
          const latest = this.#pending.get(id);
          if (latest?.generation === refresh.generation) {
            this.#pending.delete(id);
            return this.#refresh(id, latest);
          }
          return this.#refresh(id, refresh);
        })
        .finally(() => {
          this.#active.delete(id);
          this.#pump();
        });
      this.#active.set(id, task);
    }
  }
  async #refresh(id: string, refresh: Refresh): Promise<void> {
    const { tenant, session } = refresh;
    if (!this.#valid(refresh) || !this.options.watched(tenant, session)) return;
    try {
      const value = await this.options.read(tenant, session);
      if (!this.#valid(refresh) || !this.options.watched(tenant, session)) return;
      if (value.sessionId !== session) throw new Error("Queue snapshot scope changed");
      // Control-reference versions and native commit sequences are different
      // namespaces. Compare snapshots only with snapshots, and coalesce wakes locally.
      const pending = this.#pending.get(id);
      if (pending && pending.version > refresh.version) return;
      const old = this.#queues.get(id)?.value;
      if (old && BigInt(old.viewVersion) > BigInt(value.viewVersion)) return;
      const bytes = Buffer.byteLength(JSON.stringify(value)),
        maximum = this.options.maximumBytes ?? 64 * 1024 * 1024;
      this.#remove(id);
      while (
        this.#queues.size &&
        (this.#bytes + bytes > maximum || this.#queues.size >= (this.options.maximumQueues ?? 256))
      )
        this.#remove(this.#queues.keys().next().value!);
      if (bytes <= maximum) {
        this.#queues.set(id, { tenant, value, bytes });
        this.#bytes += bytes;
      }
      this.options.publish(tenant, value);
    } catch {
      if (!this.#valid(refresh)) return;
      this.#remove(id);
      try {
        this.options.unavailable(tenant, session);
        this.options.onError?.();
      } catch {
        /* Disposable observation. */
      }
    }
  }
  async settle(): Promise<void> {
    while (this.#active.size) await Promise.allSettled([...this.#active.values()]);
  }
  async close(): Promise<void> {
    this.#closed = true;
    this.reset();
    await this.settle();
  }
}
