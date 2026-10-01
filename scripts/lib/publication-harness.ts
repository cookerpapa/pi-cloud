import { KafkaLogConsumer, type ProducerCapacity } from "@pi-cloud/event-log";
import {
  ExecutionLogTopic,
  type ExecutionLogTopicOptions,
} from "../../packages/runtime-core/src/execution-log-topic.ts";
import { SessionPublicationIngress } from "../../packages/runtime-core/src/session-publication-ingress.ts";
import { kafkaProducerLane } from "../../packages/runtime-core/src/kafka-accepted-fact.ts";
import type { AcceptedFact } from "../../packages/runtime-core/src/accepted-fact.ts";

/** Isolated transport acceptance only. Installs fixture grants instead of PG
 * authority; production Workers must use the private publication HTTP client. */
export class PublicationHarness {
  readonly #topic: ExecutionLogTopic;
  readonly #consumer: KafkaLogConsumer<AcceptedFact>;
  readonly #ingress: SessionPublicationIngress;
  readonly #runs = new Set<string>();
  #retired: Promise<unknown> = Promise.resolve();
  constructor(
    readonly options: ExecutionLogTopicOptions & { topic: string; capacity?: ProducerCapacity },
  ) {
    this.#topic = new ExecutionLogTopic(options);
    this.#ingress = new SessionPublicationIngress(options.capacity);
    this.#consumer = new KafkaLogConsumer({
      ...options,
      groupId: `${options.topic}-publication-fixture`,
      groupRecovery: true,
      orderedEffects: true,
      decode: (bytes) => JSON.parse(bytes.toString()),
      handler: async () => {},
      onRevoked: () => {
        this.#runs.clear();
        this.#retired = Promise.allSettled(
          Array.from({ length: options.partitions }, (_, p) => this.#ingress.revoke(p)),
        );
      },
      onAssigned: async (partitions, current) => {
        await this.#retired;
        await Promise.all(
          partitions.map(async (partition) => {
            const writer = await this.#consumer.openPublicationWriter(partition, current);
            if (current()) this.#ingress.installPartition(partition, writer);
            else await writer.close();
          }),
        );
      },
    });
  }
  async start(): Promise<void> {
    await this.#topic.start();
    await this.#consumer.start();
    await this.#consumer.waitUntilAssigned(30_000);
  }
  append(fact: AcceptedFact) {
    const partition = kafkaProducerLane(fact.scope.piSessionId, this.options.partitions);
    const owner = this.#ingress.ownership(partition);
    if (!owner) return Promise.reject(new Error("Fixture publication owner unavailable"));
    if (!this.#runs.has(fact.scope.runId)) {
      this.#ingress.installRun(owner, {
        scope: {
          ...fact.scope,
          leaseId: fact.scope.writerId,
          piSessionLane: "piSession" in fact ? fact.piSession.lane : "main",
        },
      });
      this.#runs.add(fact.scope.runId);
    }
    return fact.kind === "execution_seal"
      ? this.#ingress.seal(owner, fact)
      : this.#ingress.append(owner, fact);
  }
  statistics() {
    return this.#ingress.statistics();
  }
  async close(): Promise<void> {
    await this.#ingress.close();
    await this.#consumer.close();
    await this.#topic.close();
  }
}
