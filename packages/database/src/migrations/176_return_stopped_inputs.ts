import { sql, type Kysely } from "kysely";

export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`
    lock table runs, session_leases, outbox in share row exclusive mode;
    do $$ begin
      if exists(select 1 from runs where state not in ('queued','completed','failed','cancelled','timed_out')
          or (lease_id is not null and output_sealed_at is null))
        or exists(select 1 from session_leases where released_at is null)
        or exists(select 1 from outbox where aggregate_type='session_terminal_event' and published_at is null)
      then raise exception 'Drain executions, Session leases and seals before changing stopped inputs';
      end if;
    end $$;
    drop trigger input_queue_run_change on runs;
    alter table runs add column input_return_request_id uuid
      references turn_control_requests(id) on delete set null
      check (input_return_request_id is null or (ready_at is null and lease_id is null));
    -- Paused drafts already belong to an accepted Stop. Preserve them as
    -- withdrawals during the quiescent cutover; never silently resume them.
    update runs r set input_return_request_id=(select c.id from turn_control_requests c
      where c.tenant_id=r.tenant_id and c.session_id=r.session_id and c.kind='cancel'
      order by c.created_at desc,c.id desc limit 1)
      where r.state='queued' and r.input_paused;
    do $$ begin
      if exists(select 1 from runs where state='queued' and input_paused and input_return_request_id is null)
      then raise exception 'Paused input is missing its durable Stop request'; end if;
    end $$;
    with withdrawn as (
      update runs set state='cancelled',stop_reason='queued_input_withdrawn',
        settled_at=clock_timestamp(),updated_at=clock_timestamp(),row_version=row_version+1
      where input_return_request_id is not null and queued_steer_id is null
      returning id,tenant_id,turn_id
    ), turns_updated as (
      update turns t set state='cancelled',stop_reason='queued_input_withdrawn',settled_at=clock_timestamp()
      from withdrawn w where t.id=w.turn_id and t.tenant_id=w.tenant_id
    ) insert into run_transitions(id,tenant_id,run_id,from_state,to_state,reason,occurred_at)
      select gen_random_uuid(),tenant_id,id,'queued','cancelled','queued_input_withdrawn',clock_timestamp() from withdrawn;
    alter table runs drop column input_paused;
    create index runs_returned_inputs on runs (tenant_id,session_id,mailbox_position)
      where input_return_request_id is not null;
    create or replace function pi_cloud_input_queue_run_change() returns trigger language plpgsql as $$
    begin
      if TG_OP='UPDATE' and NEW.state=OLD.state and NEW.mailbox_position=OLD.mailbox_position
        and NEW.queued_steer_id is not distinct from OLD.queued_steer_id
        and NEW.lease_id is not distinct from OLD.lease_id
        and NEW.input_return_request_id is not distinct from OLD.input_return_request_id then return NEW; end if;
      if TG_OP='DELETE' then
        perform pi_cloud_input_queue_change(OLD.tenant_id,OLD.session_id);
        return OLD;
      end if;
      perform pi_cloud_input_queue_change(NEW.tenant_id,NEW.session_id,
        NEW.state='queued' and NEW.queued_steer_id is not null and
        (TG_OP='INSERT' or NEW.queued_steer_id is distinct from OLD.queued_steer_id));
      return NEW;
    end $$;
    create trigger input_queue_run_change after insert or delete or
      update of state,mailbox_position,queued_steer_id,lease_id,input_return_request_id
      on runs for each row execute function pi_cloud_input_queue_run_change();
    select pi_cloud_input_queue_change(tenant_id,session_id,true) from
      (select distinct tenant_id,session_id from runs where input_return_request_id is not null) affected;
  `.execute(database);
}

export async function down(): Promise<void> {
  throw new Error(
    "Restore the matched drained database and runtime before reverting input withdrawal",
  );
}
