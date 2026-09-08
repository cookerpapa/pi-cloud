import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { KafkaAcceptedFactConsumer } from "./kafka-accepted-fact-consumer.ts";
import { ExecutionStreamProjector } from "./execution-stream-projection.ts";
import { loadFactReplayOffsets } from "./accepted-fact-recovery.ts";
import { KafkaSafeRetention } from "./kafka-safe-retention.ts";

export class KafkaCanonicalProjector {
  readonly #projection: ExecutionStreamProjector;
  readonly #consumer: KafkaAcceptedFactConsumer;
  readonly #retention: KafkaSafeRetention;

  constructor(options: {
    database: Kysely<Database>;
    brokers: readonly string[];
    topic: string;
    clientId: string;
    groupId?: string;
    retentionMs: number;
  }) {
    this.#projection = new ExecutionStreamProjector(options.database);
    this.#retention = new KafkaSafeRetention({ ...options, graceMs: options.retentionMs });
    this.#consumer = new KafkaAcceptedFactConsumer({
      brokers: options.brokers,
      clientId: `${options.clientId}-canonical-projector`,
      groupId: options.groupId ?? "pi-cloud-canonical-projector-v4",
      topic: options.topic,
      onReset: () => this.#projection.reset(),
      replayOffsets: (bounds) => loadFactReplayOffsets(options.database, options.topic, bounds),
      handler: (record) => this.#projection.project(record),
    });
  }

  async start(): Promise<void> {
    await this.#consumer.start();
    this.#retention.start(await this.#consumer.partitionCount());
  }

  checkHealth(): void {
    this.#consumer.checkHealth();
    this.#retention.checkHealth();
  }

  async close(): Promise<void> {
    await this.#retention.close();
    await this.#consumer.close();
  }
}
