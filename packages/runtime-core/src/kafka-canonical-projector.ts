import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { KafkaAcceptedFactConsumer } from "./kafka-accepted-fact-consumer.ts";
import { PostgresPiSessionMutationProjector } from "./postgres-pi-session-mutation-projector.ts";

export class KafkaCanonicalProjector {
  readonly #mutations: PostgresPiSessionMutationProjector;
  readonly #consumer: KafkaAcceptedFactConsumer;

  constructor(options: {
    database: Kysely<Database>;
    brokers: readonly string[];
    topic: string;
    clientId: string;
  }) {
    this.#mutations = new PostgresPiSessionMutationProjector(options.database);
    this.#consumer = new KafkaAcceptedFactConsumer({
      brokers: options.brokers,
      clientId: `${options.clientId}-canonical-projector`,
      groupId: "pi-cloud-canonical-projector-v1",
      topic: options.topic,
      mode: "committed",
      commitEvery: 64,
      handler: async (record) => {
        if (record.fact.kind === "pi_session_mutation") {
          await this.#mutations.project(record.fact, true);
        }
      },
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
