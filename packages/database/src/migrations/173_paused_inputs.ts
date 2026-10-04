import { sql, type Kysely } from "kysely";

export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`
    lock table runs, session_leases, outbox in share row exclusive mode;
    do $$ begin
      if exists(select 1 from runs where state not in ('queued','completed','failed','cancelled','timed_out')
          or (lease_id is not null and output_sealed_at is null))
        or exists(select 1 from session_leases where released_at is null)
        or exists(select 1 from outbox where aggregate_type='session_terminal_event' and published_at is null)
      then raise exception 'Drain executions, Session leases and seals before paused inputs';
      end if;
    end $$;
    alter table runs add column input_paused boolean not null default false
      check (not input_paused or (ready_at is null and lease_id is null));
    create or replace function pi_cloud_input_queue_run_change() returns trigger language plpgsql as $$
    begin
      if TG_OP='UPDATE' and NEW.state=OLD.state and NEW.mailbox_position=OLD.mailbox_position
        and NEW.queued_steer_id is not distinct from OLD.queued_steer_id
        and NEW.lease_id is not distinct from OLD.lease_id
        and NEW.input_paused=OLD.input_paused then return NEW; end if;
      if TG_OP='DELETE' then
        perform pi_cloud_input_queue_change(OLD.tenant_id,OLD.session_id);
        return OLD;
      end if;
      perform pi_cloud_input_queue_change(NEW.tenant_id,NEW.session_id,
        NEW.state='queued' and NEW.queued_steer_id is not null and
        (TG_OP='INSERT' or NEW.queued_steer_id is distinct from OLD.queued_steer_id));
      return NEW;
    end $$;
    drop trigger input_queue_run_change on runs;
    create trigger input_queue_run_change after insert or delete or
      update of state,mailbox_position,queued_steer_id,lease_id,input_paused
      on runs for each row execute function pi_cloud_input_queue_run_change();
  `.execute(database);
}

export async function down(): Promise<void> {
  throw new Error(
    "Restore the matched drained database and runtime before reverting paused inputs",
  );
}
