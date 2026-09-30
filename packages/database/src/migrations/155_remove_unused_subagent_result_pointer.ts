import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  // Results are selected from native history by Run/Turn. This pointer has no
  // readers, ownership role or independent result body to preserve.
  await sql`alter table subagent_executions drop column result_entry_id`.execute(database);
}

export async function down(): Promise<void> {
  throw new Error("Unused Subagent pointer removal is forward-only");
}
