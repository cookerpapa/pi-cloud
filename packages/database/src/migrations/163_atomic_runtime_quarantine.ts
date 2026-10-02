import { sql, type Kysely } from "kysely";

/** Resource quarantine is authoritative even when its notification cannot leave PG. */
export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`
    create index sandbox_tool_bindings_physical on sandbox_tool_bindings((snapshot->>'physicalActivationId'),tenant_id);
    create function pi_cloud_runtime_quarantine_bindings() returns trigger language plpgsql as $$
    declare physical_id text;
    begin
      if NEW.state <> 'unknown' then return NEW; end if;
      physical_id := case when TG_TABLE_NAME='workspace_runtimes'
        then to_jsonb(NEW)->>'workspace_runtime_id' else to_jsonb(NEW)->>'id' end;
      update sandbox_tool_bindings set dispatch_closed=true
        where tenant_id=NEW.tenant_id and snapshot->>'physicalActivationId'=physical_id
          and not dispatch_closed;
      return NEW;
    end $$;
    create trigger workspace_runtime_quarantine_bindings after update of state on workspace_runtimes
      for each row execute function pi_cloud_runtime_quarantine_bindings();
    create trigger development_environment_quarantine_bindings after update of state on development_environments
      for each row execute function pi_cloud_runtime_quarantine_bindings();
    -- The drained cutover also repairs any earlier interrupted quarantine.
    update sandbox_tool_bindings b set dispatch_closed=true where not b.dispatch_closed and (
      exists(select 1 from workspace_runtimes r where r.tenant_id=b.tenant_id
        and r.workspace_runtime_id::text=b.snapshot->>'physicalActivationId' and r.state='unknown')
      or exists(select 1 from development_environments r where r.tenant_id=b.tenant_id
        and r.id::text=b.snapshot->>'physicalActivationId' and r.state='unknown')
    );
  `.execute(database);
}
export async function down(): Promise<void> {
  throw new Error("Restore the matched database/application before atomic runtime quarantine");
}
