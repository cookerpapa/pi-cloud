import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter table execution_grants
      rename column event_writer_connection_id to fact_channel_connection_id;
    alter table execution_grants
      rename column event_writer_instance_id to fact_channel_instance_id;
    alter table execution_grants
      rename column event_writer_valid_until to fact_channel_valid_until;
    alter table execution_grants
      rename constraint execution_grants_event_writer_complete
      to execution_grants_fact_channel_complete;
    alter index execution_grants_event_writer_connection_unique
      rename to execution_grants_fact_channel_connection_unique;
    alter index execution_grants_event_writer_expiry
      rename to execution_grants_fact_channel_expiry
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
    alter index execution_grants_fact_channel_expiry
      rename to execution_grants_event_writer_expiry;
    alter index execution_grants_fact_channel_connection_unique
      rename to execution_grants_event_writer_connection_unique;
    alter table execution_grants
      rename constraint execution_grants_fact_channel_complete
      to execution_grants_event_writer_complete;
    alter table execution_grants
      rename column fact_channel_valid_until to event_writer_valid_until;
    alter table execution_grants
      rename column fact_channel_instance_id to event_writer_instance_id;
    alter table execution_grants
      rename column fact_channel_connection_id to event_writer_connection_id
  `.execute(db);
}
