import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable("session_kafka_heads")
    .addColumn("tenant_id", "uuid", (column) => column.notNull())
    .addColumn("session_id", "uuid", (column) => column.notNull())
    .addColumn("topic", "varchar(249)", (column) => column.notNull())
    .addColumn("kafka_partition", "integer", (column) => column.notNull())
    .addColumn("kafka_offset", "bigint", (column) => column.notNull())
    .addColumn("canonical_event_seq", "bigint", (column) => column.notNull())
    .addColumn("updated_at", "timestamptz", (column) => column.notNull().defaultTo(sql`now()`))
    .addPrimaryKeyConstraint("session_kafka_heads_pkey", ["tenant_id", "session_id"])
    .addForeignKeyConstraint(
      "session_kafka_heads_session_fk",
      ["tenant_id", "session_id"],
      "sessions",
      ["tenant_id", "id"],
      (constraint) => constraint.onDelete("cascade"),
    )
    .addCheckConstraint("session_kafka_heads_partition_valid", sql`kafka_partition >= 0`)
    .addCheckConstraint("session_kafka_heads_offset_valid", sql`kafka_offset >= 0`)
    .addCheckConstraint("session_kafka_heads_sequence_valid", sql`canonical_event_seq >= 0`)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable("session_kafka_heads").ifExists().execute();
}
