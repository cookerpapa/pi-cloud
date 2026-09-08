import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`do $$ begin
    if exists(select 1 from runs where state in ('claimed','provisioning','restoring','running','settling','cancel_requested'))
      or exists(select 1 from outbox where published_at is null)
      or exists(select 1 from run_attempts where output_seal_id is not null and output_sealed_at is null) then
      raise exception 'Drain Runs and project all execution seals before native Kafka cutover';
    end if;
  end $$`.execute(db);
  await sql`
    drop table pi_session_mutation_results;
    alter table pi_session_log drop column mutation_result;
    alter table pi_session_log rename column mutation_id to append_id;
    alter table pi_sessions add column active_writer_id uuid;
    alter table run_attempts
      add column native_writer_anchor_id uuid,
      add column native_writer_id uuid generated always as (coalesce(native_writer_anchor_id,id)) stored,
      add column native_output_drained boolean not null default true,
      add column native_writer_failed_at timestamptz,
      add column native_writer_sealed_at timestamptz,
      add column native_writer_seal_offset bigint;
    create index run_attempts_native_writer_idx on run_attempts(tenant_id,native_writer_id);
    alter table session_terminal_events add column interrupted_prefix text;
    create index session_terminal_pending_recovery_idx on session_terminal_events(tenant_id,session_id,occurred_at)
      where interrupted_prefix is not null;
  `.execute(db);
}

export async function down(): Promise<void> {
  throw new Error("Native Kafka rollback requires a drained protocol deployment");
}
