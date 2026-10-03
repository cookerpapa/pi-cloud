import type { InputQueueResource, SessionControlChange } from "@pi-cloud/protocol";

const key = (tenant: string, session: string) => `${tenant}:${session}`;
type Cached = { tenant: string; value: InputQueueResource; bytes: number };
type Refresh = { change: SessionControlChange; current(): boolean; generation: number };

/** Disposable watched pages. Slow SQL never owns the ordered Projector callback. */
export class InputQueueView {
  readonly #queues = new Map<string, Cached>();
  readonly #pending = new Map<string, Refresh>();
  readonly #active = new Map<string, Promise<void>>();
  #bytes = 0;
  #generation = 0;
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
    // Old reads retain their slots until they actually settle. Their generation
    // prevents installation; reassignment cannot multiply outstanding queries.
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
    if (this.#closed || change.entity !== "input_queue" || !current()) return;
    const tenant = change.scope.tenantId,
      session = change.entityId,
      id = key(tenant, session);
    for (const [cachedId, cached] of this.#queues)
      if (!this.options.watched(cached.tenant, cached.value.sessionId)) this.#remove(cachedId);
    if (!this.options.watched(tenant, session)) return;
    if (BigInt(this.#queues.get(id)?.value.viewVersion ?? "0") >= BigInt(change.version)) return;
    const pending = this.#pending.get(id);
    if (pending && BigInt(pending.change.version) >= BigInt(change.version)) return;
    if (!pending && this.#pending.size >= (this.options.maximumQueues ?? 256)) {
      this.#remove(id);
      this.options.unavailable(tenant, session);
      return;
    }
    this.#pending.set(id, { change, current, generation: this.#generation });
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
        .then(() => this.#refresh(id, refresh))
        .finally(() => {
          this.#active.delete(id);
          this.#pump();
        });
      this.#active.set(id, task);
    }
  }
  async #refresh(id: string, refresh: Refresh): Promise<void> {
    const { change } = refresh,
      tenant = change.scope.tenantId,
      session = change.entityId;
    if (!this.#valid(refresh) || !this.options.watched(tenant, session)) return;
    if (BigInt(this.#queues.get(id)?.value.viewVersion ?? "0") >= BigInt(change.version)) return;
    try {
      const value = await this.options.read(tenant, session);
      if (!this.#valid(refresh) || !this.options.watched(tenant, session)) return;
      if (value.sessionId !== session || BigInt(value.viewVersion) < BigInt(change.version))
        throw new Error("Input queue snapshot is behind its committed change");
      const pending = this.#pending.get(id);
      if (pending && BigInt(pending.change.version) > BigInt(value.viewVersion)) return;
      if (pending) this.#pending.delete(id);
      if (BigInt(this.#queues.get(id)?.value.viewVersion ?? "0") > BigInt(value.viewVersion))
        return;
      const bytes = Buffer.byteLength(JSON.stringify(value));
      const maximum = this.options.maximumBytes ?? 64 * 1024 * 1024;
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
      // A disconnected observer recovers by a current snapshot, never by
      // retrying a Kafka record or creating another durable execution queue.
      try {
        this.options.unavailable(tenant, session);
        this.options.onError?.();
      } catch {
        /* observation only */
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
