import { sql, type Kysely } from "kysely";

/** Matched development cutover; no legacy live journal reader. */
export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`
    lock table runs,session_leases,pi_sessions,pi_durable_commits in share row exclusive mode;
    do $$ begin
      if exists(select 1 from runs where state in ('queued','running','settling','cancel_requested'))
        or exists(select 1 from session_leases where released_at is null)
        or exists(select 1 from pi_sessions where unsealed_runs<>0)
      then raise exception 'Drain writers and project seals before native live cutover'; end if;
      if exists(select 1 from pi_durable_commits)
      then raise exception 'Remove obsolete development native history before live cutover'; end if;
    end $$;
    alter table pi_durable_current
      add column replay_topic text,
      add column replay_partition integer,
      add column replay_offset bigint,
      add column replay_seq bigint,
      add constraint native_live_replay_reference check (
        (replay_topic is null and replay_partition is null and replay_offset is null and replay_seq is null)
        or (kind='document' and replay_topic is not null and replay_partition>=0
          and replay_offset>=0 and replay_seq>seq
          and replay_partition is not null and replay_offset is not null and replay_seq is not null)
      );
    create index pi_durable_live_replay_floor
      on pi_durable_current(replay_topic,replay_partition,replay_offset)
      where replay_offset is not null;
    create index pi_durable_live_replay_session
      on pi_durable_current(tenant_id,session_id)
      where replay_offset is not null;
  `.execute(database);
}

export async function down(): Promise<void> {
  throw new Error(
    "Restore a drained matched release; live progress is not retained in the PG journal",
  );
}
