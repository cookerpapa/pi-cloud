import { sql, type Kysely } from "kysely";

export async function up<DB>(db: Kysely<DB>): Promise<void> {
  await sql`lock table runs,sessions,session_leases in share row exclusive mode;
    do $$ begin
      if exists(select 1 from session_leases where released_at is null)
      then raise exception 'Drain Session writers before scheduled-input cutover'; end if;
    end $$;
    alter table runs add column scheduled_origin jsonb;
    do $$ declare original text; begin
      original := regexp_replace(pg_get_viewdef('conversation_turns'::regclass,true), ';[[:space:]]*$', '');
      execute 'create or replace view conversation_turns as select base.*, origin_run.scheduled_origin from (' || original ||
        ') base left join runs origin_run on origin_run.tenant_id=base.tenant_id and origin_run.session_id=base.session_id and origin_run.id=base.id';
    end $$;
    create index runs_session_receiving on runs(tenant_id,session_id,mailbox_position) where pruned_at is null
      and (state not in ('queued','completed','failed','cancelled','timed_out') or recovery_requested_at is not null or (output_seal_id is not null and output_sealed_at is null));
    create index runs_session_pending_input on runs(tenant_id,session_id,mailbox_position) where state='queued' and pruned_at is null;
    create table session_schedules (
      id uuid primary key,
      tenant_id uuid not null references tenants(id),
      session_id uuid not null,
      name text not null check(length(name) between 1 and 128),
      prompt text not null,
      timing jsonb not null,
      missed text not null default 'latest' check(missed in ('latest','skip')),
      enabled boolean not null default true,
      revision bigint not null default 1 check(revision>0),
      next_fire_at timestamptz,
      available_at timestamptz,
      last_run_id uuid references runs(id) on delete set null,
      last_skipped_at timestamptz,
      error_code text, error_message text,
      retry_count integer not null default 0 check(retry_count>=0),
      create_request_sha256 text not null,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      foreign key(tenant_id,session_id) references sessions(tenant_id,id) on delete cascade,
      check(not enabled or (next_fire_at is not null and available_at is not null and available_at>=next_fire_at))
    );
    create index session_schedules_due on session_schedules(available_at,id) where enabled;
    create index session_schedules_session on session_schedules(tenant_id,session_id,id);
    create function pi_cloud_notify_schedule_change() returns trigger language plpgsql as $$
      begin perform pg_notify('pi_cloud_schedules',''); return null; end $$;
    create trigger schedule_change after insert or delete on session_schedules
      for each statement execute function pi_cloud_notify_schedule_change();
    create trigger schedule_time_change after update of enabled,available_at on session_schedules
      for each row when(old.enabled is distinct from new.enabled or old.available_at is distinct from new.available_at)
      execute function pi_cloud_notify_schedule_change();`.execute(db);
}
export async function down(): Promise<void> {
  throw new Error("Use a drained matched scheduled-input release");
}
