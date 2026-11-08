import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    lock table session_leases, sandbox_tool_bindings, outbox in share row exclusive mode;
    do $$ begin
      if exists(select 1 from session_leases where released_at is null)
      then raise exception 'Drain Session writers before execution binding cutover'; end if;
    end $$;
    alter table session_leases add column tool_bindings_closed_at timestamptz;
    alter table outbox add column applied_at timestamptz;
    create index outbox_binding_closure_pending on outbox(aggregate_id)
      where topic='session.control.changed.v1' and applied_at is null
        and payload->>'entity'='sandbox_binding' and payload->>'closed'='true';
    create or replace function pi_cloud_runtime_quarantine_bindings() returns trigger language plpgsql as $$
    declare physical_id text;
    begin
      if TG_TABLE_NAME='workspace_runtimes' then
        if not NEW.allocation_closed and NEW.state not in ('unknown','cleaning','released') then return NEW; end if;
        physical_id := to_jsonb(NEW)->>'workspace_runtime_id';
      else
        if not NEW.allocation_closed and NEW.state not in ('reconciling','releasing','failed','released') then return NEW; end if;
        physical_id := to_jsonb(NEW)->>'allocation_id';
      end if;
      update sandbox_tool_bindings set dispatch_closed=true
        where tenant_id=NEW.tenant_id and snapshot->>'physicalActivationId'=physical_id and not dispatch_closed;
      return NEW;
    end $$;
    drop trigger workspace_runtime_quarantine_bindings on workspace_runtimes;
    create trigger workspace_runtime_quarantine_bindings after update of state,allocation_closed on workspace_runtimes
      for each row execute function pi_cloud_runtime_quarantine_bindings();
    drop trigger development_environment_quarantine_bindings on development_environments;
    create trigger development_environment_quarantine_bindings after update of state,allocation_closed on development_environments
      for each row execute function pi_cloud_runtime_quarantine_bindings();
  `.execute(database);
}
export async function down(): Promise<void> {
  throw new Error("Binding admission requires a matched drained runtime release");
}
