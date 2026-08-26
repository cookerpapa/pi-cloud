import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { sql } from "kysely";
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
      handler: async (record) => {
        if (record.fact.kind === "pi_session_mutation") {
          await this.#mutations.project(record.fact);
        } else if (record.fact.kind === "terminal_event") {
          await sql`
            insert into session_kafka_heads(
              tenant_id, session_id, topic, kafka_partition, kafka_offset,
              canonical_event_seq, updated_at
            ) values (
              ${record.fact.scope.tenantId}, ${record.fact.scope.sessionId}, ${record.topic},
              ${record.partition}, ${record.offset}, ${record.fact.event.seq}, now()
            )
            on conflict (tenant_id, session_id) do update
              set topic = excluded.topic,
                  kafka_partition = excluded.kafka_partition,
                  kafka_offset = excluded.kafka_offset,
                  canonical_event_seq = excluded.canonical_event_seq,
                  updated_at = excluded.updated_at
              where session_kafka_heads.kafka_offset <= excluded.kafka_offset
          `.execute(this.#database);
        }
      },
    });
  }

  start(): Promise<void> {
    return this.#consumer.start();
  }

  checkHealth(): void {
    this.#consumer.checkHealth();
  }

  close(): Promise<void> {
    return this.#consumer.close();
  }
}
