import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create index turn_control_requests_pending_run_idx
    on turn_control_requests (target_run_id)
    where state in ('pending','dispatched','acknowledged')`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop index turn_control_requests_pending_run_idx`.execute(db);
}
