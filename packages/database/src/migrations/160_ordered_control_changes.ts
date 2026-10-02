import { sql, type Kysely } from "kysely";

export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`
    lock table runs, session_leases, outbox in share row exclusive mode;
    do $$ begin
      if exists(select 1 from runs where state not in ('completed','failed','cancelled','timed_out')
          or (lease_id is not null and output_sealed_at is null))
        or exists(select 1 from session_leases where released_at is null)
        or exists(select 1 from outbox where aggregate_type='session_terminal_event' and published_at is null)
      then raise exception 'Drain Runs, Session leases and seals before ordered control views';
      end if;
    end $$;
    alter table outbox drop constraint outbox_terminal_topic_only;
    alter table outbox add constraint outbox_session_control_only check (
      (topic='session.event.accepted.v1' and aggregate_type='session_terminal_event') or
      (topic='session.control.changed.v1' and aggregate_type='session_control_change'
        and payload->>'kind'='control_change' and octet_length(payload::text)<=4096)
    );
    create index outbox_control_entity_pending on outbox(aggregate_id,created_at,id)
      where published_at is null and aggregate_type='session_control_change';
    create sequence session_control_change_version;
    alter table sandbox_tool_bindings add column revision bigint not null default 0;
    alter table sandbox_tool_bindings add column pi_session_id text;
    update sandbox_tool_bindings b set pi_session_id=s.pi_session_id
      from runs r join sessions s on s.id=r.session_id and s.tenant_id=r.tenant_id
      where r.id=b.run_id and r.tenant_id=b.tenant_id;
    delete from sandbox_tool_bindings where pi_session_id is null;
    alter table sandbox_tool_bindings alter column pi_session_id set not null;
    create index sandbox_tool_bindings_session on sandbox_tool_bindings(tenant_id,pi_session_id);

    create function pi_cloud_control_change(tenant uuid, physical_session text, entity text,
      entity_id uuid, revision bigint, detail jsonb) returns uuid language plpgsql as $$
    declare event_id uuid := gen_random_uuid();
    begin
      insert into outbox(id,tenant_id,aggregate_type,aggregate_id,topic,payload,last_error)
      values(event_id,tenant,'session_control_change',entity_id,'session.control.changed.v1',
        jsonb_build_object('kind','control_change','factId',event_id,
          'scope',jsonb_build_object('tenantId',tenant,'piSessionId',physical_session),
          'entity',entity,'entityId',entity_id,'version',revision::text,
          'occurredAt',clock_timestamp()) || detail,null);
      perform pg_notify('pi_cloud_session_control','');
      return event_id;
    end $$;

    create function pi_cloud_binding_change() returns trigger language plpgsql as $$
    declare revision bigint;
    begin
      if TG_OP='DELETE' then
        if exists(select 1 from tenants where id=OLD.tenant_id) then
          perform pi_cloud_control_change(OLD.tenant_id,OLD.pi_session_id,'sandbox_binding',
            OLD.binding_id,nextval('session_control_change_version'),jsonb_build_object('closed',true,'runId',OLD.run_id));
        end if;
        return OLD;
      end if;
      if TG_OP='UPDATE' and NEW is not distinct from OLD then return NEW; end if;
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
      end if;
      NEW.revision := nextval('session_control_change_version');
      perform pi_cloud_control_change(NEW.tenant_id,NEW.pi_session_id,'sandbox_binding',
        NEW.binding_id,NEW.revision,jsonb_build_object('closed',NEW.dispatch_closed,'runId',NEW.run_id));
      return NEW;
    end $$;
    create trigger sandbox_binding_control_change before insert or update or delete
      on sandbox_tool_bindings for each row execute function pi_cloud_binding_change();
  `.execute(database);
}

export async function down(): Promise<void> {
  throw new Error(
    "Restore the matched drained database and application before ordered control views",
  );
}
