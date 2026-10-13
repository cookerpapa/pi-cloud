import { sql, type Kysely } from "kysely";

/** One matched transition; old native routes/replies cannot execute in the new runtime. */
export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`
    lock table runs,session_leases,pi_sessions,pi_durable_commits in share row exclusive mode;
    do $$ begin
      if exists(select 1 from runs where state in ('queued','running','settling','cancel_requested'))
        or exists(select 1 from session_leases where released_at is null)
        or exists(select 1 from pi_sessions where unsealed_runs<>0)
      then raise exception 'Drain writers and project closure before Session work cutover'; end if;
      if exists(select 1 from pi_durable_commits)
      then raise exception 'Remove obsolete development native history before Session work cutover'; end if;
      if exists(select 1 from session_leases)
      then raise exception 'Clean obsolete closed ownership records after draining before Session work cutover'; end if;
    end $$;
    -- The matched release moves to execution-topic v16. These are disposable
    -- positions of the retired topic, after the ownership/history guards above.
    truncate accepted_fact_projection_offsets;
    alter table pi_durable_commits add column cloud_metadata text;
    create index pi_durable_control_commits
      on pi_durable_commits(tenant_id,session_id,seq)
      where cloud_metadata is not null;
    create index pi_durable_conversation_work
      on pi_durable_records(tenant_id,session_id,((fields->>'conversation')),((fields->>'run')))
      where kind in ('task','submission');
    drop trigger subagent_run_change on runs;
    drop function pi_cloud_subagent_run_change();
    drop table subagent_control_commands;
    drop function pi_cloud_subagent_command_change();
    drop function pi_cloud_subagent_command_notify();
    truncate subagent_supervisor_requests;
    drop table subagent_executions cascade;
    drop function pi_cloud_subagent_execution_change();
    create table subagent_conversations (
      id uuid primary key, tenant_id uuid not null references tenants(id) on delete cascade,
      root_run_id uuid not null, root_session_id uuid not null,
      parent_session_id uuid not null, parent_turn_id uuid not null, parent_tool_call_id text not null,
      parent_execution_id uuid references subagent_conversations(id) on delete cascade,
      depth integer not null check(depth>0),
      source_sequence bigint not null check(source_sequence>0),
      source_record_id bigint not null check(source_record_id>0),
      source_kind text not null check(source_kind in ('task','document.create')),
      request_sha256 text not null,
      child_session_id uuid not null unique, child_turn_id uuid not null unique,
      agent_name text not null, context_mode text not null check(context_mode in ('fresh','branch')),
      pi_context_base_entry_id bigint,
      sandbox_mode text not null check(sandbox_mode in ('none','shared','ephemeral')),
      output_display_seq bigint not null default 0 check(output_display_seq>=0),
      output_display_native_seq bigint not null default 0 check(output_display_native_seq>=0),
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp(),
      unique(tenant_id,id),
      unique(tenant_id,root_run_id,source_sequence,source_record_id),
      foreign key(tenant_id,root_run_id) references runs(tenant_id,id) on delete cascade,
      foreign key(tenant_id,root_session_id) references sessions(tenant_id,id) on delete cascade,
      foreign key(tenant_id,parent_session_id) references sessions(tenant_id,id) on delete cascade,
      foreign key(tenant_id,child_session_id) references sessions(tenant_id,id) on delete cascade
    );
    create index subagent_conversations_root on subagent_conversations(tenant_id,root_run_id);
    create index subagent_conversations_parent on subagent_conversations(tenant_id,parent_session_id,created_at);
    alter table subagent_supervisor_requests add foreign key(tenant_id,execution_id)
      references subagent_conversations(tenant_id,id) on delete cascade;
    -- This is a read model of Pi's persisted state, not a second lifecycle.
    -- A completing generation remains active while its ordinary descendants run.
    create view subagent_executions as
    select e.*, progress.state,
      case when progress.state='failed' then 'native_task_failed'
           when progress.state='unknown' then 'native_work_interrupted' else null end as failure_code,
      case when progress.state='failed' then 'Native conversation did not complete its input'
           when progress.state='unknown' then 'Root work ended before native completion' else null end as failure_message,
      case when progress.state in ('completed','failed','cancelled','unknown')
        then coalesce(native.settled_at,root.settled_at,e.updated_at) else null end as settled_at
    from subagent_conversations e
    join sessions child on child.tenant_id=e.tenant_id and child.id=e.child_session_id
    join runs root on root.tenant_id=e.tenant_id and root.id=e.root_run_id
    left join lateral (
      select bool_or(r.kind='task' and r.fields->>'background'='false' and r.fields->>'status'<>'terminal') as active,
        bool_or(r.kind='submission' and r.fields->>'status' in ('queued','placed')) as pending,
        bool_or(r.kind='submission' and r.fields->>'request'=to_jsonb(root.id::text)::text) as admitted,
        bool_or(r.kind='submission' and r.fields->>'status'='unanswered' and
          (r.fields->>'entry' is not null or r.fields->>'request'=to_jsonb(root.id::text)::text)) as unanswered,
        bool_or(r.kind='submission' and r.fields->>'status'='unanswered' and r.fields->>'reason'='aborted' and
          (r.fields->>'entry' is not null or r.fields->>'request'=to_jsonb(root.id::text)::text)) as aborted,
        max(c.committed_at) as settled_at
      from pi_durable_records r join pi_durable_commits c using(tenant_id,session_id,seq)
      where r.tenant_id=e.tenant_id and r.session_id=child.pi_session_id
        and r.kind in ('task','submission') and r.fields->>'conversation'=child.pi_conversation_id::text
        and r.fields->>'run'=root.id::text
    ) native on true
    left join pi_durable_records caller on caller.tenant_id=e.tenant_id and caller.session_id=child.pi_session_id
      and caller.id=substring(e.parent_tool_call_id from 6)::bigint and caller.kind='task'
    cross join lateral (select case
      when (native.active or native.pending) and root.state in ('completed','failed','timed_out','cancelled')
        then case when root.state='cancelled' then 'cancelled' else 'unknown' end
      when native.active or native.pending then 'running'
      when native.aborted then 'cancelled'
      when native.unanswered then 'failed'
      when native.admitted then 'completed'
      when exists(select 1 from pi_durable_records stopped
        where stopped.tenant_id=e.tenant_id and stopped.session_id=child.pi_session_id and stopped.kind='document'
          and stopped.fields->>'nativeKind'='"pi-cloud.conversation-stop"'
          and stopped.fields->>'key'=to_jsonb(e.id::text)::text) then 'cancelled'
      when root.state='cancelled' or caller.fields->>'abortRequested'='true' then 'cancelled'
      when root.state in ('failed','timed_out','completed') or caller.fields->>'status'='terminal' then 'unknown'
      else 'preparing' end as state) progress;
    create view conversation_turns as
      select id,tenant_id,session_id,turn_id,input_text,input_uploads,state,mailbox_position,
        created_at,started_at,settled_at,pruned_at,output_seal_id,output_sealed_at,
        output_display_seq,output_display_native_seq,null::text as input_source from runs
      union all
      select e.root_run_id,e.tenant_id,e.child_session_id,e.child_turn_id,
        ''::text,
        '[]'::jsonb,case e.state when 'preparing' then 'queued' when 'unknown' then 'failed' else e.state end,
        1::bigint,e.created_at,case when s.pi_conversation_id is null then null else e.created_at end,
        e.settled_at,s.pruned_at,null::uuid,e.settled_at,e.output_display_seq,e.output_display_native_seq,source.body
      from subagent_executions e join sessions s on s.tenant_id=e.tenant_id and s.id=e.child_session_id
      left join pi_durable_log source on source.tenant_id=e.tenant_id and source.session_id=s.pi_session_id
        and source.seq=e.source_sequence and source.record_id=e.source_record_id and source.record_kind=e.source_kind;
    alter table session_terminal_events drop constraint session_terminal_events_run_fk,
      add constraint session_terminal_events_run_fk foreign key(tenant_id,run_id)
        references runs(tenant_id,id) on delete cascade;
    alter table session_terminal_events drop constraint session_terminal_events_tenant_id_session_id_turn_id_fkey,
      add foreign key(tenant_id,session_id) references sessions(tenant_id,id) on delete cascade;
    -- Turn addresses also name native child views. Cold fork admission checks
    -- the unified read model under Session quiescence; a root-Run FK is invalid.
    alter table conversation_fork_operations drop constraint conversation_fork_operations_source_turn_id_fkey;
    alter table sessions drop constraint sessions_conversation_fork_turn_id_fkey;
    drop trigger runs_count_unsealed on runs;
    drop trigger pi_sessions_notify_closed_family on pi_sessions;
    drop function pi_cloud_count_unsealed_runs();
    alter table pi_sessions drop column unsealed_runs;
    alter table runs drop column native_output_drained;
    create function pi_cloud_guard_writer_handoff() returns trigger language plpgsql as $$
    begin
      if OLD.lease_id is not null and NEW.lease_id is distinct from OLD.lease_id then
        if NEW.lease_id is not null or OLD.execution_released_at is null
          or not exists(select 1 from session_leases l where l.lease_id=OLD.lease_id
            and l.writer_seal_offset is not null and l.released_at is not null)
        then raise exception 'Seal and release the previous Session writer before recovery'; end if;
      end if;
      return NEW;
    end $$;
    create trigger runs_guard_writer_handoff before update of lease_id on runs
      for each row execute function pi_cloud_guard_writer_handoff();
    alter table session_leases add constraint released_writer_closed
      check(released_at is null or (writer_sealed_at is not null and writer_seal_offset is not null));
    create or replace function pi_cloud_notify_run_queue() returns trigger language plpgsql as $$
    begin
      perform pg_notify('pi_cloud_run_queue','');
      return NEW;
    end $$;
    create trigger session_leases_notify_closed_writer after update of released_at on session_leases
      for each row when(OLD.released_at is null and NEW.released_at is not null)
      execute function pi_cloud_notify_run_queue();
  `.execute(database);
}

export async function down(): Promise<void> {
  throw new Error("Session work requires a drained matched release");
}
