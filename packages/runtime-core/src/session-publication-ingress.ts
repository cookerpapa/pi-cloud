import {
  MAX_EXECUTION_FACT_BYTES,
  PublicationNotSentError,
  type SessionControlChange,
} from "@pi-cloud/protocol";
import { DEFAULT_PRODUCER_CAPACITY, type ProducerCapacity } from "@pi-cloud/event-log";
import type { PiCloudMetrics } from "@pi-cloud/observability";
import type { AcceptedFactReceipt } from "./accepted-fact.ts";

export type PublicationRecord = Readonly<{ factId: string; sessionId: string; value: string }>;
export interface PartitionPublicationWriter {
  append(record: PublicationRecord): Promise<AcceptedFactReceipt>;
  close(): Promise<void>;
}
export type PublicationOwnership = Readonly<{ partition: number; generation: symbol }>;
type Partition = {
  owner: PublicationOwnership;
  transport: PartitionPublicationWriter;
  current: boolean;
  queues: Map<string, { tail: Promise<void>; pending: number }>;
};
export class PublicationIngressRejected extends PublicationNotSentError {
  constructor(readonly reason: "not_owner" | "scope" | "capacity" | "size") {
    super(`Control publication rejected before Kafka admission: ${reason}`);
    this.name = "PublicationIngressRejected";
  }
}
/** Bounded, ordered control publication only. Workers own their Session producers. */
export class SessionPublicationIngress {
  readonly #partitions = new Map<number, Partition>();
  #pendingBytes = 0;
  #pendingFacts = 0;
  constructor(
    readonly capacity: ProducerCapacity = DEFAULT_PRODUCER_CAPACITY,
    readonly metrics?: PiCloudMetrics,
  ) {
    for (const value of [capacity.maximumPendingBytes, capacity.maximumPendingFacts])
      if (!Number.isSafeInteger(value) || value < 1)
        throw new Error("Invalid publication capacity");
    this.#observe();
  }
  installPartition(partition: number, transport: PartitionPublicationWriter): PublicationOwnership {
    if (!Number.isSafeInteger(partition) || partition < 0) throw new Error("Invalid partition");
    if (this.#partitions.get(partition)?.current)
      throw new Error("Retire publication ownership before replacement");
    const owner = { partition, generation: Symbol("control-owner") };
    this.#partitions.set(partition, { owner, transport, current: true, queues: new Map() });
    return owner;
  }
  ownership(partition: number): PublicationOwnership | undefined {
    const active = this.#partitions.get(partition);
    return active?.current ? active.owner : undefined;
  }
  revoke(partition: number): Promise<void> {
    const active = this.#partitions.get(partition);
    if (!active) return Promise.resolve();
    active.current = false;
    return active.transport.close();
  }
  #owned(owner: PublicationOwnership): Partition {
    const active = this.#partitions.get(owner.partition);
    if (!active?.current || active.owner !== owner)
      throw new PublicationIngressRejected("not_owner");
    return active;
  }
  control(owner: PublicationOwnership, fact: SessionControlChange): Promise<AcceptedFactReceipt> {
    return this.#enqueue(this.#owned(owner), fact);
  }
  #enqueue(partition: Partition, fact: SessionControlChange): Promise<AcceptedFactReceipt> {
    const record = {
      factId: fact.factId,
      sessionId: fact.scope.piSessionId,
      value: JSON.stringify(fact),
    };
    const bytes = Buffer.byteLength(record.value);
    if (bytes > MAX_EXECUTION_FACT_BYTES) throw new PublicationIngressRejected("size");
    if (
      this.#pendingFacts >= this.capacity.maximumPendingFacts ||
      this.#pendingBytes + bytes > this.capacity.maximumPendingBytes
    ) {
      this.metrics?.kafkaProducerRejected.inc();
      throw new PublicationIngressRejected("capacity");
    }
    this.#pendingFacts++;
    this.#pendingBytes += bytes;
    this.#observe();
    const enqueuedAt = performance.now();
    const key = `${fact.scope.tenantId}:${fact.scope.piSessionId}`;
    let queue = partition.queues.get(key);
    if (!queue) partition.queues.set(key, (queue = { tail: Promise.resolve(), pending: 0 }));
    const activeQueue = queue;
    activeQueue.pending++;
    const pending = activeQueue.tail
      .then(async () => {
        this.#owned(partition.owner);
        try {
          const submittedAt = performance.now();
          this.metrics?.observeSessionMutation("producer_queue", submittedAt - enqueuedAt);
          const receipt = await partition.transport.append(record);
          if (!receipt.durable || receipt.factId !== record.factId)
            throw new Error("Publication commit receipt mismatch");
          this.metrics?.observeSessionMutation("producer_ack", performance.now() - submittedAt);
          return receipt;
        } catch (error) {
          throw error;
        }
      })
      .finally(() => {
        this.#pendingFacts--;
        this.#pendingBytes -= bytes;
        activeQueue.pending--;
        if (!activeQueue.pending && partition.queues.get(key) === activeQueue)
          partition.queues.delete(key);
        this.#observe();
      });
    activeQueue.tail = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  statistics() {
    return { pendingFacts: this.#pendingFacts, pendingBytes: this.#pendingBytes };
  }
  #observe(): void {
    this.metrics?.kafkaProducerPendingBytes.set(this.#pendingBytes);
    this.metrics?.kafkaProducerPendingFacts.set(this.#pendingFacts);
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.#partitions.keys()].map((p) => this.revoke(p)));
    await Promise.allSettled(
      [...this.#partitions.values()].flatMap((p) => [...p.queues.values()].map((q) => q.tail)),
    );
    this.#partitions.clear();
  }
}
