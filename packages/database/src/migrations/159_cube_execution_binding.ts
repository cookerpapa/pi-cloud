import { sql, type Kysely } from "kysely";

/** Matched Cube/guest/control-plane cutover; old boot-local routes are not executable. */
export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`
    lock table runs, session_leases, outbox in share row exclusive mode;
    do $$ begin
      if exists(select 1 from runs where state not in ('completed','failed','cancelled','timed_out')
          or (lease_id is not null and output_sealed_at is null))
        or exists(select 1 from session_leases where released_at is null)
        or exists(select 1 from outbox where aggregate_type='session_terminal_event' and published_at is null)
      then raise exception 'Drain Runs, Session leases and seals before Cube execution handoff';
      end if;
    end $$;
    delete from tool_broker_workspace_runtimes where workspace_runtime_id in (select id from development_environments);
    drop table tool_broker_binding_routes;
    create table sandbox_tool_bindings (
      binding_id uuid not null,
      tenant_id uuid not null references tenants(id) on delete cascade,
      run_id uuid not null,
      writer_id uuid not null,
      sandbox_domain_id varchar(64) not null references sandbox_domains(id),
      owner_instance_id uuid not null references tool_broker_instances(instance_id),
      dispatch_closed boolean not null default false,
      descriptor jsonb not null check (octet_length(descriptor::text)<=131072),
      snapshot jsonb not null check (octet_length(snapshot::text)<=65536),
      primary key (run_id,binding_id)
    );
    create index sandbox_tool_bindings_writer on sandbox_tool_bindings(tenant_id,writer_id);
    create index sandbox_tool_bindings_owner on sandbox_tool_bindings(owner_instance_id);
    create index sandbox_tool_bindings_worker on sandbox_tool_bindings((snapshot->'assignment'->>'sandboxId'));
    alter table tool_broker_workspace_runtimes add column sandbox_profile_key varchar(32) not null default 'starter'
      check (sandbox_profile_key in ('starter','standard','performance'));
    alter table tool_broker_workspace_runtimes add column runtime_capsule text
      check (runtime_capsule is null or octet_length(runtime_capsule)<=131072);
    alter table tool_broker_instances rename to sandbox_control_instances;
    alter table tool_broker_workspace_runtimes rename to workspace_runtimes;
    alter table sandbox_domains rename column tool_broker_base_url to sandbox_control_base_url;
  `.execute(database);
}
export async function down(): Promise<void> {
  throw new Error("Restore the matched drained database and Cube execution binaries");
}
