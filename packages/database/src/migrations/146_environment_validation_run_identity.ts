import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`alter table environment_validations
    add constraint environment_validations_run_unique unique(environment_version_id,run_id)`.execute(
    db,
  );
}

export async function down(): Promise<void> {
  throw new Error("Run execution identity is not reversible");
}
