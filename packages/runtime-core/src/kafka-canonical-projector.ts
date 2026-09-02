import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { KafkaAcceptedFactConsumer } from "./kafka-accepted-fact-consumer.ts";
import { PostgresPiSessionMutationProjector } from "./postgres-pi-session-mutation-projector.ts";

export class KafkaCanonicalProjector {
  readonly #database: Kysely<Database>;
  readonly #mutations: PostgresPiSessionMutationProjector;
  readonly #consumer: KafkaAcceptedFactConsumer;

  constructor(options: {
    database: Kysely<Database>;
    brokers: readonly string[];
    topic: string;
    clientId: string;
  }) {
    this.#database = options.database;
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
          const session = await this.#database
            .selectFrom("sessions")
            .select("id")
            .where("tenant_id", "=", record.fact.scope.tenantId)
            .where("id", "=", record.fact.scope.sessionId)
            .executeTakeFirst();
          if (session === undefined) return;
          await this.#mutations.project(record.fact);
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
