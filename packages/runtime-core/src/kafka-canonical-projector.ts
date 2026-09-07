import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { KafkaAcceptedFactConsumer } from "./kafka-accepted-fact-consumer.ts";
import { ExecutionStreamProjector } from "./execution-stream-projection.ts";

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
      groupId: options.groupId ?? "pi-cloud-canonical-projector-v2",
      topic: options.topic,
      mode: "earliest",
      // Commits expose operational lag. Recovery deliberately rebuilds the
      // volatile prefix instead of treating an offset as a fold checkpoint.
      commitEvery: 64,
      onReset: () => this.#projection.reset(),
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
