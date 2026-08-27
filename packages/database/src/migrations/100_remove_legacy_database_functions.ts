import type { Kysely } from "kysely";
import { sql } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`drop function if exists agent_dock_reject_orchestration_acceptance_mutation()`.execute(
    db,
  );
  await sql`drop function if exists agent_dock_reject_review_bundle_mutation()`.execute(db);
}

export async function down(): Promise<void> {
  throw new Error("Legacy database-function removal is an irreversible pre-release migration");
}
