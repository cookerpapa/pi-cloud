import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("execution_grants")
    .addColumn("event_writer_connection_id", "uuid")
    .addColumn("event_writer_instance_id", "uuid")
    .addColumn("event_writer_valid_until", "timestamptz")
    .execute();
  await sql`
    alter table execution_grants
      add constraint execution_grants_event_writer_complete check (
        (event_writer_connection_id is null
          and event_writer_instance_id is null
          and event_writer_valid_until is null)
        or
        (event_writer_connection_id is not null
          and event_writer_instance_id is not null
          and event_writer_valid_until is not null
          and event_writer_valid_until <= valid_until)
      )
  `.execute(db);
  await db.schema
    .createIndex("execution_grants_event_writer_connection_unique")
    .unique()
    .on("execution_grants")
    .column("event_writer_connection_id")
    .where("event_writer_connection_id", "is not", null)
    .execute();
  await db.schema
    .createIndex("execution_grants_event_writer_expiry")
    .on("execution_grants")
    .column("event_writer_valid_until")
    .where("event_writer_valid_until", "is not", null)
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropIndex("execution_grants_event_writer_expiry").ifExists().execute();
  await db.schema.dropIndex("execution_grants_event_writer_connection_unique").ifExists().execute();
  await sql`
    alter table execution_grants
      drop constraint if exists execution_grants_event_writer_complete
  `.execute(db);
  await db.schema
    .alterTable("execution_grants")
    .dropColumn("event_writer_valid_until")
    .dropColumn("event_writer_instance_id")
    .dropColumn("event_writer_connection_id")
    .execute();
}
