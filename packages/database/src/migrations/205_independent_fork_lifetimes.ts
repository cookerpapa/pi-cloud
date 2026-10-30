import { sql, type Kysely } from "kysely";

/** Historical source addresses do not own the lifetime of independent Forks. */
export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    alter table sessions drop constraint sessions_conversation_parent_fk;
    alter table conversation_fork_operations
      drop constraint conversation_fork_operations_tenant_id_source_session_id_fkey;
    comment on column sessions.conversation_parent_session_id is
      'Historical Fork source, not runtime ownership. May name a deleted Session.';
  `.execute(database);
}

export async function down(): Promise<void> {
  throw new Error(
    "Independent Fork provenance may reference deleted sources; use a matched release",
  );
}
