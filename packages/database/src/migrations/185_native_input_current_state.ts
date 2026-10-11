import { sql, type Kysely } from "kysely";

/** Matched development cutover: no legacy journal reader or queue dual-write. */
export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`
    lock table runs,session_leases,pi_sessions,pi_durable_commits in share row exclusive mode;
    do $$ begin
      if exists(select 1 from runs where state in ('queued','running','settling','cancel_requested'))
        or exists(select 1 from session_leases where released_at is null)
        or exists(select 1 from pi_sessions where unsealed_runs<>0)
      then raise exception 'Drain writers and project seals before native current-state cutover'; end if;
      if exists(select 1 from pi_durable_commits)
      then raise exception 'Remove obsolete development conversation history before native current-state cutover'; end if;
    end $$;
    alter table pi_durable_commits
      add column history_write_count int not null check(history_write_count>=0),
      add column history_fingerprint text not null,
      add column current_hashes jsonb not null;
    create table pi_durable_current (
      tenant_id uuid not null, session_id text not null, id bigint not null,
      kind text not null check(kind in ('submission','document')),
      seq bigint not null, ordinal int not null,
      body text not null, delta_count int not null check(delta_count>=0),
      created_seq bigint, retired_seq bigint, cloud_origin jsonb,
      primary key(tenant_id,session_id,id),
      unique(tenant_id,session_id,seq,ordinal),
      foreign key(tenant_id,session_id,seq) references pi_durable_commits on delete cascade
    );
    alter table pi_durable_records drop constraint pi_durable_records_tenant_id_session_id_seq_ordinal_fkey;
    alter table pi_durable_records add foreign key(tenant_id,session_id,seq)
      references pi_durable_commits on delete cascade;
    create view pi_durable_record_bodies as
      select tenant_id,session_id,seq,ordinal,record_kind,record_id,body,phase,cloud_origin
        from pi_durable_log
      union all
      select tenant_id,session_id,seq,ordinal,
        case when kind='document' then 'document.create' else kind end,
        id,body,null::text,cloud_origin from pi_durable_current;
  `.execute(database);
}

export async function down(): Promise<void> {
  throw new Error(
    "Restore a drained matched native schema/runtime release; queue edit history is not retained",
  );
}
