import { sql, type Kysely } from "kysely";

/** Device reply references and scoped HTTPS completion require matched writers. */
export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`do $$ begin
    if exists(select 1 from session_leases where released_at is null)
      or exists(select 1 from pi_durable_current where replay_offset is not null)
      or exists(select 1 from execution_target_bindings)
    then raise exception 'Drain native writers, replay suffixes and device bindings before executor continuation'; end if;
  end $$`.execute(database);
}

export async function down(): Promise<void> {
  throw new Error("Executor continuation requires a matched drained release");
}
