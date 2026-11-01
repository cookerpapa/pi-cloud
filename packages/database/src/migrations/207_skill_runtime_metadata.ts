import { sql, type Kysely } from "kysely";
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table skill_versions add column runtime_metadata jsonb;
    create index skill_versions_pending_metadata on skill_versions(id) where published and runtime_metadata is null;`.execute(
    db,
  );
}
export async function down(): Promise<void> {
  throw Error("Use a matched Skill runtime release");
}
