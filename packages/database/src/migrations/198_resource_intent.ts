import { sql, type Kysely } from "kysely";

export async function up<DB>(db: Kysely<DB>): Promise<void> {
  await sql`
    lock table runs, session_leases, workspace_runtimes, workspace_terminal_sessions,
      sandbox_tool_bindings, development_environments, development_environment_operations in share row exclusive mode;
    do $$ begin
      if exists(select 1 from runs where state in ('queued','running','settling','cancel_requested')
          or recovery_requested_at is not null or (output_seal_id is not null and output_sealed_at is null))
        or exists(select 1 from session_leases where released_at is null)
        or exists(select 1 from sandbox_tool_bindings)
        or exists(select 1 from workspace_runtimes where state <> 'released')
        or exists(select 1 from workspace_terminal_sessions where state <> 'released')
        or exists(select 1 from development_environments where state <> 'released' and not (
          state='failed' and allocation_closed and runtime_id is null and runtime_name is null
          and agent_activation_id is null and not terminal_active))
      then raise exception 'Drain writers and confirm physical cleanup before resource-intent migration'; end if;
    end $$;
    alter table development_environments
      drop constraint development_environments_state_valid,
      drop constraint development_environments_runtime_shape,
      add column desired_state varchar(16) not null default 'running'
        check (desired_state in ('running','paused','released')),
      add column intent_revision bigint not null default 1 check (intent_revision > 0),
      add column allocation_id uuid not null default gen_random_uuid(),
      add column allocation_absent boolean not null default false;
    update development_environments set allocation_id=id,
      desired_state=case when state='paused' then 'paused' when state='released' then 'released' else 'running' end,
      state=case when state in ('running','paused') then 'ready' when state='unknown' then 'reconciling' else state end;
    alter table development_environments
      add constraint development_environments_allocation_unique unique(allocation_id),
      add constraint development_environments_state_valid
        check(state in ('requested','provisioning','ready','reconciling','releasing','released','failed')),
      add constraint development_environments_runtime_shape check (
        (runtime_id is null)=(runtime_name is null) and
        (state <> 'ready' or (runtime_id is not null and not allocation_closed)) and
        (not allocation_absent or allocation_closed));
    drop index development_environments_live_workspace_unique;
    create unique index development_environments_live_workspace_unique
      on development_environments(tenant_id,workspace_id) where state <> 'released';
    drop trigger allocation_identity on development_environments;
    create function pi_cloud_machine_allocation_identity() returns trigger language plpgsql as $$
    begin
      if TG_OP='UPDATE' then
        if NEW.allocation_id is distinct from OLD.allocation_id then
          if not OLD.allocation_closed or not OLD.allocation_absent
            or NEW.desired_state <> 'running' or NEW.state <> 'provisioning'
            or NEW.generation <> OLD.generation+1 or NEW.creation_spec is null
            or NEW.creation_not_after is null or NEW.runtime_capsule is not null
            or NEW.runtime_id is not null or NEW.runtime_name is not null
            or NEW.allocation_closed or NEW.allocation_absent
            or OLD.agent_activation_id is not null or OLD.terminal_active
          then raise exception 'Confirm old allocation absence before replacement'; end if;
        elsif NEW.allocation_protocol is distinct from OLD.allocation_protocol
          or (OLD.creation_not_after is not null and NEW.creation_not_after is distinct from OLD.creation_not_after)
          or (OLD.creation_spec is not null and NEW.creation_spec is distinct from OLD.creation_spec)
          or (OLD.allocation_closed and not NEW.allocation_closed)
          or (OLD.allocation_absent and not NEW.allocation_absent)
        then raise exception 'Allocation authorization cannot change or reopen'; end if;
        if NEW.intent_revision < OLD.intent_revision
          or (NEW.desired_state is distinct from OLD.desired_state and NEW.intent_revision <> OLD.intent_revision+1)
        then raise exception 'Machine intent revision must advance'; end if;
      end if;
      if (NEW.creation_spec is null) <> (NEW.creation_not_after is null)
        or (NEW.creation_spec is not null and
          (NEW.allocation_protocol is distinct from 1 or NEW.creation_spec->>'activationId' is distinct from NEW.allocation_id::text))
      then raise exception 'Incomplete machine allocation authorization'; end if;
      return NEW;
    end $$;
    create trigger allocation_identity before insert or update on development_environments
      for each row execute function pi_cloud_machine_allocation_identity();
    create or replace function pi_cloud_runtime_quarantine_bindings() returns trigger language plpgsql as $$
    declare physical_id text;
    begin
      if TG_TABLE_NAME='workspace_runtimes' then
        if NEW.state <> 'unknown' then return NEW; end if;
        physical_id := to_jsonb(NEW)->>'workspace_runtime_id';
      else
        if NEW.state not in ('reconciling','releasing','failed') then return NEW; end if;
        physical_id := to_jsonb(NEW)->>'allocation_id';
      end if;
      update sandbox_tool_bindings set dispatch_closed=true
        where tenant_id=NEW.tenant_id and snapshot->>'physicalActivationId'=physical_id
          and not dispatch_closed;
      return NEW;
    end $$;
    alter table development_environment_operations
      add column intent_revision bigint not null default 1 check(intent_revision > 0);
    alter table development_environments drop column ip_address;
    alter table workspace_runtimes drop constraint tool_broker_workspace_runtimes_state_valid;
    update workspace_runtimes set state='allocated' where state in ('active','warm');
    alter table workspace_runtimes add constraint workspace_runtimes_state_valid
      check(state in ('reserved','materializing','allocated','cleaning','released','unknown'));
    drop index tool_broker_compute_live_unique;
    create unique index workspace_compute_live_unique
      on workspace_runtimes(tenant_id,workspace_id,compute_session_id) nulls not distinct
      where state <> 'released';
    drop index tool_broker_workspace_runtimes_tenant_live_idx;
    create index workspace_runtimes_tenant_live_idx
      on workspace_runtimes(tenant_id,sandbox_domain_id) where state <> 'released';
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error("Resource intent requires a matched application/schema release");
}
