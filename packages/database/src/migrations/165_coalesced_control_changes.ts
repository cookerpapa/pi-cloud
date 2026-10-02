import { sql, type Kysely } from "kysely";

export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`
    alter table outbox add column control_transaction uuid;
    create unique index outbox_transaction_control on outbox(control_transaction,tenant_id,aggregate_id,((payload->>'entity')))
      where control_transaction is not null;
    create or replace function pi_cloud_control_change(tenant uuid, physical_session text, entity text,
      entity_id uuid, revision bigint, detail jsonb) returns uuid language plpgsql as $$
    declare event_id uuid := gen_random_uuid(); transaction_id uuid;
    begin
      if entity in ('input_queue','subagent_state') then
        transaction_id := nullif(current_setting('pi_cloud.control_transaction',true),'')::uuid;
        if transaction_id is null then
          transaction_id := gen_random_uuid();
          perform set_config('pi_cloud.control_transaction',transaction_id::text,true);
        end if;
      end if;
      insert into outbox(id,tenant_id,aggregate_type,aggregate_id,topic,payload,last_error,control_transaction)
      values(event_id,tenant,'session_control_change',entity_id,'session.control.changed.v1',
        jsonb_build_object('kind','control_change','factId',event_id,
          'scope',jsonb_build_object('tenantId',tenant,'piSessionId',physical_session),
          'entity',entity,'entityId',entity_id,'version',revision::text,
          'occurredAt',clock_timestamp()) || detail,null,transaction_id)
      on conflict (control_transaction,tenant_id,aggregate_id,((payload->>'entity')))
        where control_transaction is not null
      do update set payload=excluded.payload || jsonb_build_object('factId',outbox.id)
        || case when outbox.payload->>'steerPending'='true' then '{"steerPending":true}'::jsonb else '{}'::jsonb end
        where outbox.published_at is null
      returning id into event_id;
      if event_id is null then raise exception 'A published control reference is immutable'; end if;
      perform pg_notify('pi_cloud_session_control','');
      return event_id;
    end $$;

    drop function pi_cloud_input_queue_change(uuid,uuid);
    create function pi_cloud_input_queue_change(tenant uuid, logical_session uuid, steer_pending boolean default false)
      returns void language plpgsql as $$
    declare physical_session text;
    begin
      select pi_session_id into physical_session from sessions
        where tenant_id=tenant and id=logical_session and session_kind='conversation';
      if physical_session is not null then
        perform pi_cloud_control_change(tenant,physical_session,'input_queue',logical_session,
          nextval('session_control_change_version'),
          case when steer_pending then '{"steerPending":true}'::jsonb else '{}'::jsonb end);
      end if;
    end $$;
    create or replace function pi_cloud_input_queue_run_change() returns trigger language plpgsql as $$
    begin
      if TG_OP='UPDATE' and NEW.state=OLD.state and NEW.mailbox_position=OLD.mailbox_position
        and NEW.queued_steer_id is not distinct from OLD.queued_steer_id
        and NEW.lease_id is not distinct from OLD.lease_id then return NEW; end if;
      if TG_OP='DELETE' then
        perform pi_cloud_input_queue_change(OLD.tenant_id,OLD.session_id);
        return OLD;
      end if;
      perform pi_cloud_input_queue_change(NEW.tenant_id,NEW.session_id,
        NEW.state='queued' and NEW.queued_steer_id is not null and
        (TG_OP='INSERT' or NEW.queued_steer_id is distinct from OLD.queued_steer_id));
      return NEW;
    end $$;

    drop trigger subagent_command_change on subagent_control_commands;
    create or replace function pi_cloud_subagent_command_change() returns trigger language plpgsql as $$
    begin
      if TG_OP='UPDATE' and row(NEW.child_execution_id,NEW.supervisor_request_id,NEW.target_session_id,
          NEW.input_run_id,NEW.input_consumed_at is not null,NEW.response,NEW.delivered_at is not null)
        is not distinct from row(OLD.child_execution_id,OLD.supervisor_request_id,OLD.target_session_id,
          OLD.input_run_id,OLD.input_consumed_at is not null,OLD.response,OLD.delivered_at is not null)
      then NEW.revision := OLD.revision;
      else NEW.revision := nextval('session_control_change_version'); end if;
      return NEW;
    end $$;
    create function pi_cloud_subagent_command_notify() returns trigger language plpgsql as $$
    begin
      if TG_OP='DELETE' then
        perform pi_cloud_subagent_change(OLD.tenant_id,OLD.run_id,'subagent_command',OLD.id,nextval('session_control_change_version'));
        return OLD;
      end if;
      if TG_OP='INSERT' or NEW.revision is distinct from OLD.revision then
        perform pi_cloud_subagent_change(NEW.tenant_id,NEW.run_id,'subagent_command',NEW.id,NEW.revision);
      end if;
      return NEW;
    end $$;
    create trigger subagent_command_revision before insert or update on subagent_control_commands
      for each row execute function pi_cloud_subagent_command_change();
    create trigger subagent_command_notify after insert or update or delete on subagent_control_commands
      for each row execute function pi_cloud_subagent_command_notify();
  `.execute(database);
}
export async function down(): Promise<void> {
  throw new Error("Restore the matched database/application before coalesced control changes");
}
