import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // A cutover is allowed only after the old writers and their output seals drain.
  await sql`do $$ begin
    if exists(select 1 from runs where state in ('claimed','provisioning','restoring','running','settling','cancel_requested'))
      or exists(select 1 from session_leases)
      or exists(select 1 from run_attempts where output_seal_id is not null and output_sealed_at is null)
      or exists(select 1 from outbox where aggregate_type='session_terminal_event' and published_at is null)
    then raise exception 'Drain executions, Session leases and seals before first-record cutover'; end if;
  end $$;
  alter table run_attempts drop column output_open_offset;`.execute(db);
}

export async function down(): Promise<void> {
  throw new Error("Restore a drained backup to undo the first-record execution cutover");
}
