import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`do $$ begin
    if exists(select 1 from runs where state not in ('completed','failed','cancelled','timed_out','superseded'))
      or exists(select 1 from session_leases)
      or exists(select 1 from run_attempts where output_publication is not null and output_sealed_at is null)
      or exists(select 1 from outbox where aggregate_type='session_terminal_event' and published_at is null)
    then raise exception 'Drain inputs, owners and seals before Run identity cutover'; end if;
    if exists(select 1 from run_attempts group by run_id having count(*)>1) then
      raise exception 'Multiple historical Attempts cannot be merged into one Run'; end if;
    if exists(select 1 from runs where state='superseded') then
      raise exception 'Retire superseded execution history before Run identity cutover'; end if;
  end $$;
  drop view active_execution_scopes;
  drop trigger run_attempts_count_unsealed on run_attempts;
  drop function pi_cloud_count_unsealed_runs();

  alter table runs
    add column sandbox_id uuid references sandboxes(id),
    add column lease_id uuid,
    add column fencing_token bigint,
    add column execution_released_at timestamptz,
    add column agent_exited_at timestamptz,
    add column last_heartbeat_at timestamptz,
    add column last_event_seq bigint not null default 0 check(last_event_seq>=0),
    add column output_seal_id uuid,
    add column output_seal_offset bigint,
    add column output_sealed_at timestamptz,
    add column output_first_topic text,
    add column output_first_partition integer,
    add column output_first_offset bigint,
    add column output_projected_offset bigint,
    add column output_display_seq bigint not null default 0 check(output_display_seq>=0),
    add column output_display_native_seq bigint not null default 0 check(output_display_native_seq>=0),
    add column output_publication jsonb,
    add column native_output_drained boolean not null default false;
  update runs r set
    sandbox_id=a.sandbox_id,lease_id=a.lease_id,fencing_token=a.fencing_token,
    execution_released_at=a.execution_released_at,agent_exited_at=a.agent_exited_at,
    last_heartbeat_at=a.last_heartbeat_at,last_event_seq=a.last_event_seq,
    output_seal_id=a.output_seal_id,output_seal_offset=a.output_seal_offset,
    output_sealed_at=a.output_sealed_at,output_first_topic=a.output_first_topic,
    output_first_partition=a.output_first_partition,output_first_offset=a.output_first_offset,
    output_projected_offset=a.output_projected_offset,output_display_seq=a.output_display_seq,
    output_display_native_seq=a.output_display_native_seq,output_publication=a.output_publication,
    native_output_drained=a.native_output_drained
    from run_attempts a where a.run_id=r.id;

  alter table environment_validations drop column attempt_id;
  alter table model_requests drop column attempt_id;
  alter table usage_ledger drop column attempt_id;
  alter table subagent_executions drop column parent_attempt_id;
  alter table subagent_control_commands drop column attempt_id;
  alter table tool_broker_operations drop column attempt_id;
  alter table tool_broker_workspace_runtimes drop column attempt_id;
  alter table tool_broker_workspace_runtimes rename column attempt_context_sha256 to execution_context_sha256;
  alter table tool_broker_binding_routes drop constraint tool_broker_binding_routes_attempt_id_fkey;
  update tool_broker_binding_routes b set attempt_id=a.run_id from run_attempts a where a.id=b.attempt_id;
  alter table tool_broker_binding_routes rename column attempt_id to run_id;
  alter index tool_broker_binding_routes_attempt rename to tool_broker_binding_routes_run;
  alter table tool_broker_binding_routes add foreign key(run_id) references runs(id) on delete cascade;
  alter table subagent_control_commands drop constraint subagent_control_commands_input_attempt_id_fkey;
  update subagent_control_commands c set input_attempt_id=a.run_id from run_attempts a where a.id=c.input_attempt_id;
  alter table subagent_control_commands rename column input_attempt_id to input_run_id;
  alter table subagent_control_commands add foreign key(input_run_id) references runs(id) on delete set null;
  alter table run_attempt_transitions drop column attempt_id;
  alter table run_attempt_transitions rename to run_transitions;
  alter table run_transitions rename constraint run_attempt_transitions_pkey to run_transitions_pkey;
  alter table run_transitions rename constraint run_attempt_transitions_reason_nonempty to run_transitions_reason_nonempty;
  alter table run_transitions drop constraint run_attempt_transitions_from_state_valid;
  alter table run_transitions drop constraint run_attempt_transitions_to_state_valid;
  delete from run_transitions where to_state in ('claimed','provisioning','restoring');
  update run_transitions set from_state='queued' where from_state in ('claimed','provisioning','restoring');
  alter table run_transitions add foreign key(tenant_id,run_id) references runs(tenant_id,id);
  alter table run_transitions add check(from_state is null or from_state in
    ('queued','running','settling','cancel_requested','completed','failed','cancelled','timed_out')),
    add check(to_state in ('queued','running','settling','cancel_requested','completed','failed','cancelled','timed_out'));
  alter table runs drop constraint runs_state_valid;
  alter table runs add check(state in ('queued','running','settling','cancel_requested','completed','failed','cancelled','timed_out'));
  alter table runs drop constraint runs_settlement_shape;
  alter table runs add check((state in ('completed','failed','cancelled','timed_out'))=(settled_at is not null)),
    add check((sandbox_id is null and lease_id is null and fencing_token is null)
      or (sandbox_id is not null and lease_id is not null and fencing_token is not null and fencing_token>0));
  alter table runs drop column current_attempt_id, drop column attempt_count;

  alter table session_leases
    drop column writer_id,
    drop constraint session_leases_pkey,
    drop constraint session_leases_lease_id_key,
    add primary key(lease_id),
    add column released_at timestamptz,
    add column writer_failed_at timestamptz,
    add column writer_sealed_at timestamptz,
    add column writer_seal_offset bigint;
  create unique index session_leases_current_owner on session_leases(tenant_id,pi_session_id)
    where released_at is null;
  drop index session_leases_owner;
  create index session_leases_owner on session_leases(sandbox_id,valid_until) where released_at is null;
  drop table run_attempts;
  alter table pi_sessions drop column active_writer_id;

  alter table sandboxes drop constraint sandboxes_capacity_valid;
  alter table sandboxes drop constraint sandboxes_state_valid;
  update sandboxes set state='ready' where state='leased';
  alter table sandboxes drop column active_sessions;
  alter table sandboxes add check(max_concurrent_sessions>0),
    add check(state in ('provisioning','ready','draining','failed','terminated'));

  create index runs_owner_active on runs(sandbox_id) where lease_id is not null and execution_released_at is null;
  drop index runs_agent_queue_idx;
  create index runs_agent_queue_idx on runs(agent_revision_id,available_at,queued_at,id)
    where state='queued' and ready_at is not null;
  drop index runs_active_idx;
  create index runs_active_idx on runs(state,updated_at)
    where state in ('queued','running','settling','cancel_requested');
  create index runs_active_lease on runs(lease_id) where lease_id is not null and execution_released_at is null;
  create index runs_unsealed_prefix on runs(output_first_topic,output_first_partition,output_first_offset)
    where output_sealed_at is null and output_first_offset is not null;
  create function pi_cloud_count_unsealed_runs() returns trigger language plpgsql as $$
  declare change integer;
  begin
    if TG_OP='INSERT' then
      change := case when new.lease_id is not null and new.output_sealed_at is null then 1 else 0 end;
    else
      if old.lease_id is not null and new.lease_id is distinct from old.lease_id then
        raise exception 'An admitted Run cannot change its execution owner';
      end if;
      change := case when old.lease_id is null and new.lease_id is not null then 1 else 0 end
        - case when new.lease_id is not null and old.output_sealed_at is null and new.output_sealed_at is not null then 1 else 0 end;
    end if;
    if change<>0 then
      update pi_sessions p set unsealed_runs=p.unsealed_runs+change from sessions s
        where s.id=new.session_id and s.tenant_id=new.tenant_id
          and p.id=s.pi_session_id and p.tenant_id=s.tenant_id;
      if not found then raise exception 'Run lost its physical Session'; end if;
    end if;
    return new;
  end $$;
  create trigger runs_count_unsealed after insert or update of lease_id,output_sealed_at on runs
    for each row execute function pi_cloud_count_unsealed_runs();
  create view active_execution_scopes as
    select s.id as session_id,l.lease_id,l.sandbox_id,l.fencing_token,l.tenant_id,
      s.project_id,r.workspace_id,r.id as run_id,r.turn_id,r.last_event_seq,
      l.valid_until,l.acquired_at,l.renewed_at,l.pi_session_id,l.lease_id as writer_id,
      (r.state='running' and r.output_seal_id is null and l.writer_failed_at is null
        and l.writer_sealed_at is null) as accepting_effects
    from session_leases l
    join sessions s on s.tenant_id=l.tenant_id and s.pi_session_id=l.pi_session_id
    join runs r on r.tenant_id=s.tenant_id and r.session_id=s.id and r.lease_id=l.lease_id
      and r.sandbox_id=l.sandbox_id and r.fencing_token=l.fencing_token
      and r.execution_released_at is null
    where l.released_at is null;
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error("Run identity cutover is forward-only; restore a drained backup to downgrade");
}
