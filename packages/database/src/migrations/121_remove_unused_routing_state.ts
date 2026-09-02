import type { Kysely } from "kysely";

/**
 * Model selection is explicit on each Turn and the browser no longer owns a
 * Kafka cursor. Neither retired routing table had a runtime reader.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("model_routing_policies").ifExists().execute();
  await db.schema.dropTable("session_kafka_heads").ifExists().execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  void db;
  throw new Error(
    "121_remove_unused_routing_state is an intentional destructive cleanup; restore a pre-migration backup to roll back",
  );
}
