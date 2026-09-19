import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`do $$ begin
    if exists(select 1 from runs where state not in ('completed','failed','cancelled','timed_out','superseded'))
      or exists(select 1 from session_leases)
      or exists(select 1 from run_attempts where output_seal_id is not null and output_sealed_at is null)
      or exists(select 1 from run_attempts where output_publication is not null and output_sealed_at is null)
      or exists(select 1 from outbox where aggregate_type='session_terminal_event' and published_at is null)
    then raise exception 'Drain accepted input, executions and seals before ready-Run cutover'; end if;
  end $$;
  alter table runs add column ready_at timestamptz;
  alter table pi_sessions add column unsealed_runs bigint not null default 0
    check(unsealed_runs >= 0);
  create function pi_cloud_count_unsealed_runs() returns trigger language plpgsql as $$
  declare change integer;
  begin
    if TG_OP='INSERT' then
      change := case when new.output_sealed_at is null then 1 else 0 end;
    elsif old.output_sealed_at is null and new.output_sealed_at is not null then
      change := -1;
    else
      return new;
    end if;
    if change=0 then return new; end if;
    update pi_sessions p set unsealed_runs=p.unsealed_runs+change
      from runs r join sessions s on s.id=r.session_id and s.tenant_id=r.tenant_id
      where r.id=new.run_id and r.tenant_id=new.tenant_id
        and p.tenant_id=s.tenant_id and p.id=s.pi_session_id;
    if not found then raise exception 'Attempt lost its physical Session'; end if;
    return new;
  end $$;
  create trigger run_attempts_count_unsealed
    after insert or update of output_sealed_at on run_attempts
    for each row execute function pi_cloud_count_unsealed_runs();
  drop index runs_ready_queue_idx;
  create index runs_ready_queue_idx on runs(available_at,queued_at,id)
    where state='queued' and ready_at is not null;
  create unique index runs_one_ready_lane on runs(session_id)
    where state='queued' and ready_at is not null;
  drop trigger runs_notify_run_queue on runs;
  create trigger runs_notify_run_queue
    after insert or update of state,available_at,ready_at on runs
    for each row when(new.state='queued' and new.ready_at is not null)
    execute function pi_cloud_notify_run_queue();
  create trigger pi_sessions_notify_closed_family
    after update of unsealed_runs on pi_sessions
    for each row when(old.unsealed_runs>0 and new.unsealed_runs=0)
    execute function pi_cloud_notify_run_queue();`.execute(db);
}

export async function down(): Promise<void> {
  throw new Error("Restore a drained backup to undo ready-Run admission");
}
