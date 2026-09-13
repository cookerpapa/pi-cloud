import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`create index pi_session_entries_turn_messages on pi_session_entries(tenant_id, turn_id, seq desc)
    where type='message' and turn_id is not null`.execute(db);
  await sql`create table subagent_control_commands (
    id uuid primary key,
    ordinal bigserial not null,
    tenant_id uuid not null references tenants(id) on delete cascade,
    run_id uuid not null references runs(id) on delete cascade,
    attempt_id uuid not null references run_attempts(id) on delete cascade,
    partition integer not null,
    command jsonb not null,
    child_execution_id uuid references subagent_executions(id) on delete cascade,
    supervisor_request_id uuid references subagent_supervisor_requests(id) on delete cascade,
    target_session_id uuid references sessions(id) on delete cascade,
    input_attempt_id uuid references run_attempts(id) on delete set null,
    input_consumed_at timestamptz,
    response jsonb,
    delivered_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
  )`.execute(db);
  await sql`create index subagent_control_pending on subagent_control_commands(created_at)
    where delivered_at is null`.execute(db);
  await sql`create index subagent_control_execution on subagent_control_commands(child_execution_id)
    where child_execution_id is not null`.execute(db);
  await sql`create index subagent_control_inbox on subagent_control_commands(target_session_id, ordinal)
    where target_session_id is not null and input_consumed_at is null`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`drop table subagent_control_commands`.execute(db);
  await sql`drop index pi_session_entries_turn_messages`.execute(db);
}
