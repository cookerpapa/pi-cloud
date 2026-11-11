import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    do $$ begin
      if exists(select 1 from session_leases where released_at is null)
        or exists(select 1 from workspace_runtimes where state<>'released')
        or exists(select 1 from workspace_terminal_sessions where state<>'released')
        or exists(select 1 from development_environments where state<>'released' and not (allocation_closed and allocation_absent))
      then raise exception 'Drain writers and retire native-expiry compute before platform expiry cutover'; end if;
    end $$;
    alter table workspace_runtimes add column idle_expires_at timestamptz;
    alter table workspace_terminal_sessions add column idle_expires_at timestamptz;
    create index workspace_runtimes_idle_due on workspace_runtimes
      (sandbox_domain_id,owner_instance_id,idle_expires_at,workspace_runtime_id)
      where state='allocated' and not allocation_closed;
    create index workspace_terminals_idle_due on workspace_terminal_sessions
      (sandbox_domain_id,owner_instance_id,idle_expires_at,terminal_id)
      where state='active' and not allocation_closed;
  `.execute(database);
}
export async function down(): Promise<void> {
  throw new Error("Platform idle expiry is a matched, forward-only cutover");
}
