import {
  KafkaSessionWriter,
  DEFAULT_PRODUCER_CAPACITY,
  type ProducerCapacity,
} from "@pi-cloud/event-log";
import {
  ExecutionLogTopic,
  type ExecutionLogTopicOptions,
} from "../../packages/runtime-core/src/execution-log-topic.ts";
import { kafkaProducerLane } from "../../packages/runtime-core/src/kafka-accepted-fact.ts";
import { PublicationIngressRejected } from "../../packages/runtime-core/src/session-publication-ingress.ts";
import type { AcceptedFact } from "../../packages/runtime-core/src/accepted-fact.ts";

/** Isolated transport measurements. Synthetic grants never authorize production
 * work; the production DirectSessionKafkaBus checks fresh PG ownership twice. */
export class PublicationHarness {
  readonly #topic: ExecutionLogTopic;
  readonly #writers = new Map<string, { writer: KafkaSessionWriter; ready: Promise<void> }>();
  #closed = false;
  #bytes = 0;
  #facts = 0;
  constructor(
    readonly options: ExecutionLogTopicOptions & { topic: string; capacity?: ProducerCapacity },
  ) {
    this.#topic = new ExecutionLogTopic(options);
  }
  async start(): Promise<void> {
    await this.#topic.start();
  }
  async append(fact: AcceptedFact) {
    if (this.#closed) throw new Error("Fixture is closed");
    const value = JSON.stringify(fact),
      bytes = Buffer.byteLength(value),
      capacity = this.options.capacity ?? DEFAULT_PRODUCER_CAPACITY;
    if (
      this.#bytes + bytes > capacity.maximumPendingBytes ||
      this.#facts >= capacity.maximumPendingFacts
    )
      throw new PublicationIngressRejected("capacity");
    this.#bytes += bytes;
    this.#facts++;
    try {
      const key = `${fact.scope.tenantId}:${fact.scope.piSessionId}`;
      let entry = this.#writers.get(key);
      if (!entry) {
        const writer = new KafkaSessionWriter({
          brokers: this.options.brokers,
          clientId: this.options.clientId,
          topic: this.options.topic,
          partition: kafkaProducerLane(fact.scope.piSessionId, this.options.partitions),
          tenantId: fact.scope.tenantId,
          sessionId: fact.scope.piSessionId,
          authorize: async () => {},
          current: () => !this.#closed,
        });
        entry = { writer, ready: writer.start() };
        this.#writers.set(key, entry);
      }
      await entry.ready;
      return await entry.writer.append({
        factId: fact.factId,
        sessionId: fact.scope.piSessionId,
        value,
      });
    } finally {
      this.#bytes -= bytes;
      this.#facts--;
    }
  }
  async retire(tenant: string, session: string): Promise<void> {
    const key = `${tenant}:${session}`,
      entry = this.#writers.get(key);
    if (!entry) return;
    this.#writers.delete(key);
    await entry.writer.close();
  }
  statistics() {
    return { pendingBytes: this.#bytes, pendingFacts: this.#facts };
  }
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#writers.values()].map((e) => e.writer.close()));
    this.#writers.clear();
    await this.#topic.close();
  }
}
