import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create index pi_durable_submission_status
    on pi_durable_records(tenant_id,session_id,(fields->>'status'),id)
    where kind='submission'`.execute(db);
}

export async function down(): Promise<void> {
  throw new Error("Native recovery requires a matched application/schema release");
}
