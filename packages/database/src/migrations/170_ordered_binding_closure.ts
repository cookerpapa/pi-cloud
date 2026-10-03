import { sql, type Kysely } from "kysely";

export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`
    lock table runs, session_leases, outbox in share row exclusive mode;
    do $$ begin
      if exists(select 1 from runs where state not in ('completed','failed','cancelled','timed_out')
          or (lease_id is not null and output_sealed_at is null))
        or exists(select 1 from session_leases where released_at is null)
        or exists(select 1 from outbox where aggregate_type='session_terminal_event' and published_at is null)
      then raise exception 'Drain Runs, Session leases and seals before ordered Cube closure';
      end if;
    end $$;
    alter table sandbox_tool_bindings add column closure_revision bigint;
    alter table sandbox_tool_bindings add column closure_result jsonb
      check (closure_result is null or (dispatch_closed and
        closure_result->>'outcome' in ('stopped','quarantined') and
        octet_length(closure_result::text)<=1024));
    create or replace function pi_cloud_binding_change() returns trigger language plpgsql as $$
    begin
      if TG_OP='DELETE' then
        if exists(select 1 from tenants where id=OLD.tenant_id) then
          perform pi_cloud_control_change(OLD.tenant_id,OLD.pi_session_id,'sandbox_binding',
            OLD.binding_id,nextval('session_control_change_version'),jsonb_build_object('closed',true,'runId',OLD.run_id));
        end if;
        return OLD;
      end if;
      if TG_OP='INSERT' then
        select s.pi_session_id into NEW.pi_session_id from runs r
          join sessions s on s.id=r.session_id and s.tenant_id=r.tenant_id
          where r.id=NEW.run_id and r.tenant_id=NEW.tenant_id;
        if NEW.pi_session_id is null then raise exception 'Binding has no physical Session'; end if;
      elsif NEW.binding_id<>OLD.binding_id or NEW.tenant_id<>OLD.tenant_id or
        NEW.run_id<>OLD.run_id or NEW.writer_id<>OLD.writer_id or
        NEW.pi_session_id<>OLD.pi_session_id or NEW.descriptor<>OLD.descriptor or
        (OLD.dispatch_closed and not NEW.dispatch_closed) then
        raise exception 'Binding identity cannot change or reopen';
      elsif (to_jsonb(NEW)-'closure_result') = (to_jsonb(OLD)-'closure_result') and
        (not NEW.dispatch_closed or NEW.closure_revision is not null) then
        -- Lifecycle acknowledgements must not recursively publish control facts.
        return NEW;
      end if;
      NEW.revision := nextval('session_control_change_version');
      if NEW.dispatch_closed and NEW.closure_revision is null then
        NEW.closure_revision := NEW.revision;
        NEW.closure_result := null;
      end if;
      perform pi_cloud_control_change(NEW.tenant_id,NEW.pi_session_id,'sandbox_binding',
        NEW.binding_id,NEW.revision,jsonb_build_object('closed',NEW.dispatch_closed,'runId',NEW.run_id));
      return NEW;
    end $$;
    -- Reissue existing closed bindings through the matched ordered executor.
    update sandbox_tool_bindings set closure_revision=null where dispatch_closed;
  `.execute(database);
}

export async function down(): Promise<void> {
  throw new Error("Restore the matched drained database and Cube transport before rollback");
}
