import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
    -- This release intentionally has no execution-data compatibility path.
    -- Identity, membership, administrator and model configuration tables are
    -- outside the project graph and remain intact.
    truncate table projects cascade;
    truncate table sandboxes cascade;
    delete from outbox;
    update sandbox_domains set assigned_workspaces = 0, updated_at = now();

    create table turn_control_requests (
      id uuid primary key,
      tenant_id uuid not null references tenants(id),
      session_id uuid not null references sessions(id),
      turn_id uuid not null references turns(id),
      target_run_id uuid not null references runs(id),
      idempotency_key text not null,
      kind text not null check (kind in ('cancel', 'steer')),
      state text not null check (state in ('pending', 'dispatched', 'acknowledged', 'completed', 'failed')),
      request_sha256 char(64) not null check (request_sha256 ~ '^[0-9a-f]{64}$'),
      payload jsonb not null check (jsonb_typeof(payload) = 'object'),
      attempts integer not null default 0 check (attempts >= 0),
      available_at timestamptz not null default now(),
      created_at timestamptz not null default now(),
      dispatched_at timestamptz,
      acknowledged_at timestamptz,
      completed_at timestamptz,
      failure_code text,
      constraint turn_control_requests_session_idempotency_unique
        unique (session_id, idempotency_key),
      foreign key (tenant_id, session_id, turn_id)
        references turns(tenant_id, session_id, id)
    );

    create index turn_control_requests_cancel_ready_idx
      on turn_control_requests (available_at, created_at, id)
      where kind = 'cancel' and state in ('pending', 'dispatched');

    create unique index turn_control_requests_active_cancel_unique
      on turn_control_requests (tenant_id, turn_id)
      where kind = 'cancel' and state in ('pending', 'dispatched', 'acknowledged');

    alter table runs
      add column mailbox_position bigint,
      add column request_sha256 char(64),
      add column available_at timestamptz;

    alter table runs
      alter column mailbox_position set not null,
      alter column request_sha256 set not null,
      alter column available_at set not null;

    alter table runs
      add constraint runs_mailbox_position_positive check (mailbox_position > 0),
      add constraint runs_request_sha256_valid check (request_sha256 ~ '^[0-9a-f]{64}$'),
      add constraint runs_session_mailbox_unique unique (session_id, mailbox_position),
      add constraint runs_tenant_session_turn_id_unique unique (tenant_id, session_id, turn_id, id);

    create index runs_ready_queue_idx
      on runs (available_at, queued_at, id)
      where state in ('queued', 'claimed');

    alter table session_terminal_events add column run_id uuid;
    alter table session_terminal_events alter column run_id set not null;
    alter table session_terminal_events
      add constraint session_terminal_events_run_fk
      foreign key (tenant_id, session_id, turn_id, run_id)
      references runs(tenant_id, session_id, turn_id, id);
    alter table session_terminal_events
      drop constraint session_terminal_events_command_fk,
      drop column command_id;

    alter table tool_broker_activations add column run_id uuid;
    alter table tool_broker_activations alter column run_id set not null;
    alter table tool_broker_activations
      add constraint tool_broker_activations_run_fk foreign key (run_id) references runs(id),
      drop column command_id;

    alter table session_leases drop column command_id;

    alter table runs
      drop constraint runs_tenant_command_fk,
      drop constraint runs_tenant_command_unique,
      drop column command_id;

    delete from outbox;
    drop trigger if exists outbox_notify_run_queue on outbox;
    drop index if exists outbox_run_queue_ready;
    alter table outbox
      add constraint outbox_terminal_topic_only
      check (topic = 'session.event.accepted.v1');

    drop table commands;

    alter table turns drop constraint turns_state_valid;
    alter table turns add constraint turns_state_valid
      check (state in ('queued', 'running', 'cancelling', 'completed', 'failed', 'cancelled'));

    drop index if exists tenant_runtime_policies_scheduler;
    alter table tenant_runtime_policies
      drop constraint tenant_runtime_policies_limits_positive,
      drop column last_scheduled_at,
      drop column maximum_unsettled_turns,
      add constraint tenant_runtime_policies_limits_positive
        check (maximum_projects > 0 and maximum_sessions > 0);

    create or replace function pi_cloud_notify_run_queue()
    returns trigger
    language plpgsql
    as $$
    begin
      perform pg_notify('pi_cloud_run_queue', new.id::text);
      return new;
    end;
    $$;

    create trigger runs_notify_run_queue
    after insert or update of state, available_at on runs
    for each row
    when (new.state = 'queued')
    execute function pi_cloud_notify_run_queue();

    create trigger turn_control_requests_notify_run_queue
    after insert or update of state, available_at on turn_control_requests
    for each row
    when (new.kind = 'cancel' and new.state in ('pending', 'dispatched'))
    execute function pi_cloud_notify_run_queue();
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error(
    "103_run_queue_authority is a destructive queue-authority cutover; restore a pre-migration backup to roll back",
  );
}
