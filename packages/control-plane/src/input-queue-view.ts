import type { InputQueueResource, SessionControlChange } from "@pi-cloud/protocol";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";

const key = (tenant: string, session: string) => `${tenant}:${session}`;
type Cached = { tenant: string; value: InputQueueResource; bytes: number };

/** Only watched queues are retained. Revisions come from the same PG snapshot
 * as queue contents; an older notification or SQL reply cannot regress the UI. */
export class InputQueueView {
  readonly #queues = new Map<string, Cached>();
  #bytes = 0;
  #generation = 0;
  constructor(
    readonly options: {
      read(tenant: string, session: string): Promise<InputQueueResource>;
      watched(tenant: string, session: string): boolean;
      publish(tenant: string, queue: InputQueueResource): void;
      unavailable(tenant: string, session: string): void;
      maximumBytes?: number;
      maximumQueues?: number;
    },
  ) {}
  reset(): void {
    this.#generation++;
    this.#queues.clear();
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
  async consume(change: SessionControlChange, current: () => boolean): Promise<void> {
    if (change.entity !== "input_queue" || !current()) return;
    const tenant = change.scope.tenantId,
      session = change.entityId,
      id = key(tenant, session);
    // Cold Sessions stay in PG. A fresh stream reads its initial snapshot after
    // subscribing; observations are not a second history or a delivery queue.
    for (const [cachedId, cached] of this.#queues)
      if (!this.options.watched(cached.tenant, cached.value.sessionId)) this.#remove(cachedId);
    if (!this.options.watched(tenant, session)) return;
    if (BigInt(this.#queues.get(id)?.value.viewVersion ?? "0") >= BigInt(change.version)) return;
    const generation = this.#generation;
    let value: InputQueueResource;
    try {
      value = await this.options.read(tenant, session);
    } catch (error) {
      if (!current() || generation !== this.#generation) return;
      if (!(error instanceof ControlPlaneStoreError) || error.code !== "not_found") throw error;
      this.#remove(id);
      this.options.unavailable(tenant, session);
      return;
    }
    if (!current() || generation !== this.#generation) return;
    if (value.sessionId !== session || BigInt(value.viewVersion) < BigInt(change.version))
      throw new Error("Input queue snapshot is behind its committed change");
    if (BigInt(this.#queues.get(id)?.value.viewVersion ?? "0") > BigInt(value.viewVersion)) return;
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
  }
}
