import { sql, type Kysely } from "kysely";

export async function up(database: Kysely<unknown>): Promise<void> {
  await sql`
    do $$ begin
      if exists(select 1 from session_leases where released_at is null)
      then raise exception 'Drain Session writers before runtime continuation cutover'; end if;
      if exists(select 1 from pi_durable_current where replay_offset is not null)
      then raise exception 'Materialize protected native replay checkpoints before transport cutover'; end if;
    end $$;
    create index pi_durable_pending_tool_reply on pi_durable_owned_records
      ((fields->>'replyTopic'), ((fields->>'replyOffset')::bigint))
      where kind='task' and fields ? 'replyTopic' and fields->>'status'<>'terminal';
    create index pi_durable_pending_tool_binding on pi_durable_owned_records
      (tenant_id, (fields->>'replyBinding'))
      where kind='task' and fields ? 'replyTopic' and fields->>'status'<>'terminal';
    alter table resource_metering_resources add column lifecycle_state jsonb;
    create table resource_lifecycle_sources (
      id text primary key, provider text not null, node_id text not null,
      epoch text, after_sequence bigint not null default 0 check(after_sequence>=0),
      checked_at timestamptz, failed_at timestamptz, gap_detected_at timestamptz,
      unique(provider,node_id)
    );
  `.execute(database);
}

export async function down(): Promise<void> {
  throw new Error("Runtime continuation requires a matched drained release");
}
