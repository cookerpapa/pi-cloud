import { sql, type Kysely } from "kysely";

/** Matched cutover: the old serving runtime retires compute before its private
 * allocation protocol is removed. Stable machine intent and Workspace bytes stay. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    lock table session_leases,workspace_runtimes,workspace_terminal_sessions,
      development_environments,sandbox_tool_bindings in share row exclusive mode;
    do $$ begin
      if exists(select 1 from session_leases where released_at is null)
        or exists(select 1 from sandbox_tool_bindings)
        or exists(select 1 from workspace_runtimes where state<>'released')
        or exists(select 1 from workspace_terminal_sessions where state<>'released')
        or exists(select 1 from development_environments where not (allocation_closed and allocation_absent)
          and state<>'released')
      then raise exception 'Drain writers and confirm old compute cleanup before native resource cutover'; end if;
    end $$;
    drop trigger allocation_identity on workspace_runtimes;
    drop trigger allocation_identity on workspace_terminal_sessions;
    drop trigger allocation_identity on development_environments;
    drop function pi_cloud_allocation_identity();
    drop function pi_cloud_machine_allocation_identity();
  `.execute(db);
  for (const table of [
    "workspace_runtimes",
    "workspace_terminal_sessions",
    "development_environments",
  ]) {
    await sql`alter table ${sql.table(table)}
      drop column allocation_protocol, drop column creation_not_after,
      add column provider_create_started_at timestamptz,
      add column provider_receipt text check(provider_receipt is null or octet_length(provider_receipt) between 64 and 65536)`.execute(
      db,
    );
    if (table !== "workspace_terminal_sessions")
      await sql`alter table ${sql.table(table)} add check(runtime_capsule is null or provider_receipt is null)`.execute(
        db,
      );
  }
  await sql`
    create function pi_cloud_native_resource_identity() returns trigger language plpgsql as $$
    begin
      if TG_OP='UPDATE' then
        if TG_TABLE_NAME='development_environments'
          and (to_jsonb(NEW)->>'allocation_id') is distinct from (to_jsonb(OLD)->>'allocation_id') then
          if not OLD.allocation_closed or not OLD.allocation_absent
            or NEW.desired_state<>'running' or NEW.state<>'provisioning'
            or NEW.generation<>OLD.generation+1 or NEW.creation_spec is null
            or NEW.provider_create_started_at is not null or NEW.provider_receipt is not null
            or NEW.runtime_capsule is not null or NEW.runtime_id is not null or NEW.runtime_name is not null
            or NEW.allocation_closed or NEW.allocation_absent
            or OLD.agent_activation_id is not null or OLD.terminal_active
          then raise exception 'Confirm old provider removal before replacement'; end if;
        else
          if (OLD.creation_spec is not null and NEW.creation_spec is distinct from OLD.creation_spec)
            or (OLD.provider_create_started_at is not null and NEW.provider_create_started_at is distinct from OLD.provider_create_started_at)
            or (OLD.allocation_closed and not NEW.allocation_closed)
            or (OLD.runtime_id is not null and NEW.runtime_id is not null and NEW.runtime_id is distinct from OLD.runtime_id)
            or (OLD.runtime_name is not null and NEW.runtime_name is not null and NEW.runtime_name is distinct from OLD.runtime_name)
          then raise exception 'Native resource identity cannot change or reopen'; end if;
        end if;
        if TG_TABLE_NAME='development_environments' then
          if NEW.intent_revision<OLD.intent_revision
            or (NEW.desired_state is distinct from OLD.desired_state and NEW.intent_revision<>OLD.intent_revision+1)
          then raise exception 'Machine intent revision must advance'; end if;
          if NEW.allocation_id=OLD.allocation_id and OLD.allocation_absent and not NEW.allocation_absent
          then raise exception 'Confirmed provider removal cannot be undone'; end if;
        end if;
      end if;
      if NEW.provider_create_started_at is not null and NEW.creation_spec is null
      then raise exception 'Native create requires a retained request'; end if;
      if NEW.provider_receipt is not null and (NEW.provider_create_started_at is null or NEW.runtime_name is null)
      then raise exception 'Native creation receipt requires its original request and identity'; end if;
      return NEW;
    end $$;
    create trigger native_resource_identity before insert or update on workspace_runtimes
      for each row execute function pi_cloud_native_resource_identity();
    create trigger native_resource_identity before insert or update on workspace_terminal_sessions
      for each row execute function pi_cloud_native_resource_identity();
    create trigger native_resource_identity before insert or update on development_environments
      for each row execute function pi_cloud_native_resource_identity();
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error("Native resource ownership requires a drained matched release");
}
