import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`drop table source_control_installation_requests`.execute(db);
}

export async function down(): Promise<void> {
  throw new Error("Restore a backup to recover removed installation requests");
}
