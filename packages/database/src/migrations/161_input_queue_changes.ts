import { sql, type Kysely } from "kysely";

export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`
    create index outbox_input_queue_version on outbox(tenant_id,aggregate_id,((payload->>'version')::bigint) desc)
      where topic='session.control.changed.v1' and payload->>'entity'='input_queue';
    create function pi_cloud_input_queue_change(tenant uuid, logical_session uuid) returns void
      language plpgsql as $$
    declare physical_session text;
    begin
      select pi_session_id into physical_session from sessions
        where tenant_id=tenant and id=logical_session and session_kind='conversation';
      if physical_session is not null then
        perform pi_cloud_control_change(tenant,physical_session,'input_queue',logical_session,
          nextval('session_control_change_version'),'{}'::jsonb);
      end if;
    end $$;
    create function pi_cloud_input_queue_run_change() returns trigger language plpgsql as $$
    begin
      if TG_OP='UPDATE' and NEW.state=OLD.state and NEW.mailbox_position=OLD.mailbox_position
        and NEW.queued_steer_id is not distinct from OLD.queued_steer_id
        and NEW.lease_id is not distinct from OLD.lease_id then return NEW; end if;
      if TG_OP='DELETE' then
        perform pi_cloud_input_queue_change(OLD.tenant_id,OLD.session_id);
        return OLD;
      end if;
      perform pi_cloud_input_queue_change(NEW.tenant_id,NEW.session_id);
      return NEW;
    end $$;
    create trigger input_queue_run_change after insert or delete or update of state,mailbox_position,queued_steer_id,lease_id
      on runs for each row execute function pi_cloud_input_queue_run_change();
    create function pi_cloud_input_queue_turn_change() returns trigger language plpgsql as $$
    begin
      if NEW.input_text is distinct from OLD.input_text or NEW.input_uploads is distinct from OLD.input_uploads
        or NEW.state is distinct from OLD.state then
        perform pi_cloud_input_queue_change(NEW.tenant_id,NEW.session_id);
      end if;
      return NEW;
    end $$;
    create trigger input_queue_turn_change after update of input_text,input_uploads,state on turns
      for each row execute function pi_cloud_input_queue_turn_change();
    create function pi_cloud_input_queue_session_change() returns trigger language plpgsql as $$
    begin
      if TG_OP='DELETE' then
        if OLD.session_kind='conversation' and exists(select 1 from tenants where id=OLD.tenant_id) then
          perform pi_cloud_control_change(OLD.tenant_id,OLD.pi_session_id,'input_queue',OLD.id,
            nextval('session_control_change_version'),'{}'::jsonb);
        end if;
        return OLD;
      end if;
      if NEW.row_version is distinct from OLD.row_version or NEW.pruned_at is distinct from OLD.pruned_at then
        perform pi_cloud_input_queue_change(NEW.tenant_id,NEW.id);
      end if;
      return NEW;
    end $$;
    create trigger input_queue_session_change after delete or update of row_version,pruned_at on sessions
      for each row execute function pi_cloud_input_queue_session_change();
  `.execute(database);
}
export async function down(): Promise<void> {
  throw new Error("Restore the matched drained database and application before input queue views");
}
