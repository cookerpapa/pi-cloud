import { sql, type Kysely } from "kysely";

export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`
    create index outbox_control_version on outbox(tenant_id,aggregate_id,((payload->>'entity')),((payload->>'runId')),((payload->>'version')::bigint) desc)
      where aggregate_type='session_control_change';
    alter table subagent_control_commands add column revision bigint not null default 0;
    create index subagent_control_pending_partition on subagent_control_commands(partition,ordinal)
      where delivered_at is null or (target_session_id is not null and input_consumed_at is null);
    create index subagent_control_family on subagent_control_commands(tenant_id,((command->'scope'->>'piSessionId')));

    create function pi_cloud_subagent_change(tenant uuid, target_run uuid, entity text, entity_id uuid, revision bigint)
      returns void language plpgsql as $$
    declare physical_session text;
    begin
      select s.pi_session_id into physical_session from runs r
        join sessions s on s.id=r.session_id and s.tenant_id=r.tenant_id
        where r.id=target_run and r.tenant_id=tenant;
      if physical_session is not null then
        perform pi_cloud_control_change(tenant,physical_session,entity,entity_id,revision,'{}'::jsonb);
      end if;
    end $$;
    create function pi_cloud_subagent_command_change() returns trigger language plpgsql as $$
    begin
      if TG_OP='DELETE' then
        perform pi_cloud_subagent_change(OLD.tenant_id,OLD.run_id,'subagent_command',OLD.id,nextval('session_control_change_version'));
        return OLD;
      end if;
      if TG_OP='UPDATE' and row(NEW.child_execution_id,NEW.supervisor_request_id,NEW.target_session_id,
          NEW.input_run_id,NEW.input_consumed_at is not null,NEW.response,NEW.delivered_at is not null)
        is not distinct from row(OLD.child_execution_id,OLD.supervisor_request_id,OLD.target_session_id,
          OLD.input_run_id,OLD.input_consumed_at is not null,OLD.response,OLD.delivered_at is not null)
        then return NEW; end if;
      NEW.revision := nextval('session_control_change_version');
      perform pi_cloud_subagent_change(NEW.tenant_id,NEW.run_id,'subagent_command',NEW.id,NEW.revision);
      return NEW;
    end $$;
    create trigger subagent_command_change before insert or update or delete on subagent_control_commands
      for each row execute function pi_cloud_subagent_command_change();

    create function pi_cloud_subagent_execution_change() returns trigger language plpgsql as $$
    begin
      if TG_OP='DELETE' then
        perform pi_cloud_subagent_change(OLD.tenant_id,OLD.root_run_id,'subagent_state',OLD.root_session_id,nextval('session_control_change_version'));
        return OLD;
      end if;
      if TG_OP='UPDATE' and NEW is not distinct from OLD then return NEW; end if;
      perform pi_cloud_subagent_change(NEW.tenant_id,NEW.root_run_id,'subagent_state',NEW.root_session_id,nextval('session_control_change_version'));
      return NEW;
    end $$;
    create trigger subagent_execution_change after insert or update or delete on subagent_executions
      for each row execute function pi_cloud_subagent_execution_change();

    create function pi_cloud_subagent_run_change() returns trigger language plpgsql as $$
    declare root record;
    begin
      if row(NEW.state,NEW.output_sealed_at,NEW.lease_id,NEW.failure_code,NEW.failure_message)
        is not distinct from row(OLD.state,OLD.output_sealed_at,OLD.lease_id,OLD.failure_code,OLD.failure_message)
        then return NEW; end if;
      for root in select distinct root_run_id,root_session_id from subagent_executions
        where tenant_id=NEW.tenant_id and (child_run_id=NEW.id or parent_run_id=NEW.id or root_run_id=NEW.id)
      loop
        perform pi_cloud_subagent_change(NEW.tenant_id,root.root_run_id,'subagent_state',root.root_session_id,nextval('session_control_change_version'));
      end loop;
      return NEW;
    end $$;
    create trigger subagent_run_change after update of state,output_sealed_at,lease_id,failure_code,failure_message
      on runs for each row execute function pi_cloud_subagent_run_change();

    create function pi_cloud_subagent_supervisor_change() returns trigger language plpgsql as $$
    declare root record;
    begin
      if TG_OP='UPDATE' and NEW is not distinct from OLD then return NEW; end if;
      select tenant_id,root_run_id,root_session_id into root from subagent_executions
        where id=NEW.execution_id and tenant_id=NEW.tenant_id;
      if found then
        perform pi_cloud_subagent_change(root.tenant_id,root.root_run_id,'subagent_state',root.root_session_id,nextval('session_control_change_version'));
      end if;
      return NEW;
    end $$;
    create trigger subagent_supervisor_change after insert or update on subagent_supervisor_requests
      for each row execute function pi_cloud_subagent_supervisor_change();
    create function pi_cloud_subagent_session_deleted() returns trigger language plpgsql as $$
    begin
      if exists(select 1 from tenants where id=OLD.tenant_id) then
        perform pi_cloud_control_change(OLD.tenant_id,OLD.pi_session_id,'subagent_state',OLD.id,
          nextval('session_control_change_version'),'{}'::jsonb);
      end if;
      return OLD;
    end $$;
    create trigger subagent_session_deleted after delete on sessions
      for each row execute function pi_cloud_subagent_session_deleted();
  `.execute(database);
}
export async function down(): Promise<void> {
  throw new Error(
    "Restore the matched drained database and application before Subagent control views",
  );
}
