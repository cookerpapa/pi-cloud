import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`drop table environment_validation_evidence_backfills`.execute(db);
}

export async function down(): Promise<void> {
  throw new Error(
    "117_remove_environment_validation_backfill is destructive; restore a pre-migration backup to roll back",
  );
}
