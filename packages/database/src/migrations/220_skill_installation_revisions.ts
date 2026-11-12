import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create sequence skill_installation_revision;
    select setval('skill_installation_revision', greatest(1, coalesce((select max(revision) from skill_installations),0)+1), false);
    alter table skill_installations alter column revision set default nextval('skill_installation_revision');`.execute(
    db,
  );
}

export async function down(): Promise<void> {
  throw new Error("Skill installation identities require a matched forward update");
}
