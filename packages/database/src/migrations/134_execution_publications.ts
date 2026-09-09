import { sql, type Kysely } from "kysely";
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table run_attempts add column output_publication jsonb,
    add column output_open_offset bigint;
    alter table session_leases drop column fact_channel_connection_id,
      drop column fact_channel_instance_id, drop column fact_channel_valid_until;
    delete from outbox where payload->>'kind'='execution_committed'`.execute(db);
}
export async function down(): Promise<void> {
  throw new Error("Restore a drained backup to undo direct log publication");
}
