import { sql, type Kysely } from "kysely";

/** v12 has one fenced ingress producer per partition. Never mix its source
 * authority with the retired direct-Worker producers and v11 Projector. */
export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`
    lock table runs, session_leases, outbox in share row exclusive mode;
    do $$ begin
      if exists(select 1 from runs where state not in ('completed','failed','cancelled','timed_out')
          or (lease_id is not null and output_sealed_at is null))
        or exists(select 1 from session_leases where released_at is null)
        or exists(select 1 from outbox where aggregate_type='session_terminal_event' and published_at is null)
      then raise exception 'Drain Runs, Session leases and seals before the v12 publication cutover';
      end if;
    end $$;
  `.execute(database);
}

export async function down(): Promise<void> {
  throw new Error("Restore matched drained database and v11 binaries to undo publication cutover");
}
