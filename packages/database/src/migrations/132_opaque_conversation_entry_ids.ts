import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table sessions alter column conversation_fork_entry_id type text using conversation_fork_entry_id::text;
    alter table conversation_fork_operations alter column source_entry_id type text using source_entry_id::text`.execute(
    db,
  );
}
export async function down(): Promise<void> {
  throw new Error("Opaque Pi Entry IDs cannot be cast back to UUIDs");
}
