import { sql, type Kysely } from "kysely";

/** Matched ADR-0238 cutover: one execution row, native pending-input authority. */
export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`
    lock table sessions,turns,runs,session_leases,outbox in share row exclusive mode;
    do $$ begin
      if exists(select 1 from runs where state not in ('completed','failed','cancelled','timed_out')
          or (lease_id is not null and output_sealed_at is null))
        or exists(select 1 from session_leases where released_at is null)
        or exists(select 1 from outbox where aggregate_type='session_terminal_event' and published_at is null)
        or exists(select 1 from turn_control_requests where kind='queue' and state in ('pending','dispatched','acknowledged'))
        or exists(select 1 from turn_control_requests where payload->>'inputReturnPending'='true')
      then raise exception 'Drain executions, pending inputs, owners and seals before native input cutover'; end if;
      if exists(select 1 from turns t where not exists(select 1 from runs r where r.turn_id=t.id))
      then raise exception 'Every retained Turn must have its Run before consolidation'; end if;
    end $$;

    alter table runs
      add column input_text text,
      add column input_uploads jsonb not null default '[]'::jsonb,
      add column model_profile_id uuid,
      add column provider text,
      add column model_id text,
      add column thinking_level text,
      add column service_tier text,
      add column credential_binding_id uuid,
      add column credential_binding_version bigint,
      add column pruned_at timestamptz;
    update runs r set input_text=t.input_text,input_uploads=t.input_uploads,
      model_profile_id=t.model_profile_id,provider=t.provider,model_id=t.model_id,
      thinking_level=t.thinking_level,service_tier=t.service_tier,
      credential_binding_id=t.credential_binding_id,credential_binding_version=t.credential_binding_version,
      pruned_at=t.pruned_at from turns t where t.id=r.turn_id and t.tenant_id=r.tenant_id;
    alter table runs
      alter column input_text set not null,
      alter column model_profile_id set not null,
      alter column provider set not null,
      alter column model_id set not null,
      alter column thinking_level set not null,
      alter column credential_binding_id set not null,
      alter column credential_binding_version set not null,
      add constraint runs_input_valid check(jsonb_typeof(input_uploads)='array' and
        (char_length(input_text)>0 or jsonb_array_length(input_uploads)>0)),
      add constraint runs_model_profile_fk foreign key(tenant_id,model_profile_id) references model_profiles(tenant_id,id),
      add constraint runs_credential_snapshot_fk foreign key(tenant_id,credential_binding_id,credential_binding_version)
        references credential_bindings(tenant_id,id,version),
      add constraint runs_credential_version_positive check(credential_binding_version>0),
      add constraint runs_service_tier_valid check(service_tier is null or service_tier='fast'),
      add constraint runs_thinking_level_valid check(thinking_level in ('off','minimal','low','medium','high','xhigh','max')),
      add constraint runs_turn_identity_unique unique(turn_id),
      add constraint runs_tenant_session_turn_unique unique(tenant_id,session_id,turn_id);

    alter table runs drop constraint runs_tenant_turn_fk;
    alter table conversation_fork_operations drop constraint conversation_fork_operations_source_turn_id_fkey,
      add foreign key(source_turn_id) references runs(turn_id) on delete cascade;
    alter table conversation_prune_operations drop constraint conversation_prune_operations_turn_fk,
      add foreign key(tenant_id,session_id,anchor_turn_id) references runs(tenant_id,session_id,turn_id) on delete cascade;
    alter table session_terminal_events drop constraint session_terminal_events_turn_fk,
      add foreign key(tenant_id,session_id,turn_id) references runs(tenant_id,session_id,turn_id) on delete cascade;
    alter table sessions drop constraint sessions_conversation_fork_turn_fk,
      add foreign key(conversation_fork_turn_id) references runs(turn_id) on delete set null;
    alter table turn_control_requests
      drop constraint turn_control_requests_tenant_id_session_id_turn_id_fkey,
      drop constraint turn_control_requests_turn_id_fkey,
      add foreign key(tenant_id,session_id,turn_id) references runs(tenant_id,session_id,turn_id) on delete cascade;
    drop table turns;
    drop function pi_cloud_input_queue_turn_change();

    drop trigger input_queue_run_change on runs;
    alter table runs
      drop column queued_steer_id,
      drop column input_return_request_id,
      drop column conversation_base_seq,
      drop column output_projected_offset,
      drop column last_heartbeat_at;
    alter table sessions drop column forked_from_session_id;
    drop index runs_ready_queue_idx;
    drop index runs_agent_queue_idx;
    alter table runs drop column queued_at;
    alter table runs rename column sandbox_id to worker_id;
    create index runs_ready_queue_idx on runs(available_at,created_at,id)
      where state='queued' and ready_at is not null;
    create index runs_agent_queue_idx on runs(agent_revision_id,available_at,created_at,id)
      where state='queued' and ready_at is not null;
    create unique index runs_one_active_lane on runs(session_id)
      where state in ('running','settling','cancel_requested');
    create index runs_visible_session on runs(tenant_id,session_id,created_at) where pruned_at is null;
    create or replace function pi_cloud_input_queue_run_change() returns trigger language plpgsql as $$
    begin
      if TG_OP='UPDATE' and row(NEW.state,NEW.mailbox_position,NEW.lease_id,NEW.input_text,NEW.input_uploads)
        is not distinct from row(OLD.state,OLD.mailbox_position,OLD.lease_id,OLD.input_text,OLD.input_uploads)
      then return NEW; end if;
      if TG_OP='DELETE' then
        perform pi_cloud_input_queue_change(OLD.tenant_id,OLD.session_id); return OLD;
      end if;
      perform pi_cloud_input_queue_change(NEW.tenant_id,NEW.session_id); return NEW;
    end $$;
    create trigger input_queue_run_change after insert or delete or
      update of state,mailbox_position,lease_id,input_text,input_uploads on runs
      for each row execute function pi_cloud_input_queue_run_change();
  `.execute(database);
}

export async function down(): Promise<void> {
  throw new Error("Use a matched drained release before changing the native input contract");
}
