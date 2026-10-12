import { sql, type Kysely } from "kysely";

/** The native display selector wire has no legacy reader. Matched v15 cutover. */
export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`
    lock table runs,session_leases,pi_sessions,pi_durable_commits in share row exclusive mode;
    do $$ begin
      if exists(select 1 from runs where state in ('queued','running','settling','cancel_requested'))
        or exists(select 1 from session_leases where released_at is null)
        or exists(select 1 from pi_sessions where unsealed_runs<>0)
      then raise exception 'Drain writers and project seals before native text cutover'; end if;
      if exists(select 1 from pi_durable_commits)
      then raise exception 'Remove obsolete development native history before native text cutover'; end if;
    end $$;
  `.execute(database);
}
export async function down(): Promise<void> {
  throw new Error("Native text display requires a drained matched release");
}
