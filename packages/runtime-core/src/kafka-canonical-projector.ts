import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { KafkaAcceptedFactConsumer } from "./kafka-accepted-fact-consumer.ts";
import { ExecutionStreamProjector } from "./execution-stream-projection.ts";
import { loadFactReplayOffsets } from "./accepted-fact-recovery.ts";

export class KafkaCanonicalProjector {
  readonly #projection: ExecutionStreamProjector;
  readonly #consumer: KafkaAcceptedFactConsumer;

  constructor(options: {
    database: Kysely<Database>;
    brokers: readonly string[];
    topic: string;
    clientId: string;
    groupId?: string;
    retentionMs: number;
  }) {
    this.#projection = new ExecutionStreamProjector(options.database, options.retentionMs);
    this.#consumer = new KafkaAcceptedFactConsumer({
      brokers: options.brokers,
      clientId: `${options.clientId}-canonical-projector`,
      groupId: options.groupId ?? "pi-cloud-canonical-projector-v3",
      topic: options.topic,
      onReset: () => this.#projection.reset(),
      replayOffsets: (bounds, partitionCount) =>
        loadFactReplayOffsets(options.database, options.topic, bounds, {
          partitionCount,
          retentionMs: options.retentionMs,
        }),
      handler: (record) => this.#projection.project(record),
    });
  }

  async start(): Promise<void> {
    await this.#consumer.start();
  }

  checkHealth(): void {
    this.#consumer.checkHealth();
  }

  close(): Promise<void> {
    return this.#consumer.close();
  }
}
