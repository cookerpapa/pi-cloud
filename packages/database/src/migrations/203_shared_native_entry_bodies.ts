import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";

/** Matched, writer-drained conversion; the old and new representations never dual-write. */
export async function up<DB>(database: Kysely<DB>): Promise<void> {
  await sql`
    lock table session_leases,pi_sessions,pi_durable_commits in share row exclusive mode;
    do $$ begin
      if exists(select 1 from session_leases where released_at is null)
        or exists(select 1 from pi_durable_current where replay_offset is not null)
      then raise exception 'Drain writers and finish native replay before Entry body conversion'; end if;
    end $$;
    alter table conversation_prune_operations drop constraint conversation_prune_operations_tenant_id_session_id_anchor__fkey;
    alter table sessions add column history_imported boolean not null default true;
    update sessions set history_imported=false where session_kind='conversation' and pruned_at is null and conversation_parent_session_id is not null;
    create table pi_history_bodies (
      tenant_id uuid not null references tenants(id) on delete cascade,
      body_kind text not null default 'entry' check(body_kind in ('entry','metadata')),
      id uuid not null, sha256 text not null check(sha256 ~ '^[0-9a-f]{64}$'),
      payload_text text not null, payload_bytes bigint not null check(payload_bytes=octet_length(payload_text)),
      primary key(tenant_id,id), unique(tenant_id,body_kind,sha256)
    );
    create table pi_history_snapshots (
      tenant_id uuid not null, session_id uuid not null,
      turn_id uuid not null, origin_session_id uuid not null,
      kind text not null check(kind in ('turn','record')),
      record_id bigint not null, seq bigint not null, ordinal int not null,
      position bigint not null default 0, entry_id bigint, assistant_id bigint,
      body_id uuid not null, fields jsonb not null default '{}',
      body_bytes bigint not null default 0,
      primary key(tenant_id,session_id,turn_id,kind,record_id,seq,ordinal),
      foreign key(tenant_id,session_id) references sessions(tenant_id,id) on delete cascade,
      foreign key(tenant_id,body_id) references pi_history_bodies(tenant_id,id)
    );
    create unique index pi_history_one_turn on pi_history_snapshots(tenant_id,session_id,turn_id)
      where kind='turn';
    create index pi_history_turn_order on pi_history_snapshots(tenant_id,session_id,position)
      where kind='turn';
    create index pi_history_snapshot_entry on pi_history_snapshots(tenant_id,session_id,entry_id)
      where entry_id is not null;
    create index pi_history_snapshot_body on pi_history_snapshots(tenant_id,body_id);
    create view pi_history_turns as
      select r.tenant_id,r.session_id,r.session_id as origin_session_id,r.turn_id,r.id as run_id,
        s.pi_session_id,r.mailbox_position,r.operation_kind,r.state,r.stop_reason,
        r.output_display_seq,r.output_display_native_seq,
        (r.output_seal_id is not null and r.output_sealed_at is null) as waiting_for_seal,
        r.created_at,false as frozen
      from conversation_turns r join sessions s on s.tenant_id=r.tenant_id and s.id=r.session_id
      where r.pruned_at is null and s.pruned_at is null
        and (r.state<>'queued' or r.operation_kind='compact')
        and not(r.operation_kind='chat' and r.state='cancelled' and r.started_at is null)
        and not exists(select 1 from pi_history_snapshots h where h.tenant_id=r.tenant_id
          and h.session_id=r.session_id and h.turn_id=r.turn_id and h.kind='turn')
      union all
      select h.tenant_id,h.session_id,h.origin_session_id,h.turn_id,(h.fields->>'runId')::uuid,
        s.pi_session_id,h.position,h.fields->>'operationKind',h.fields->>'runState',h.fields->>'stopReason',
        (h.fields->>'coverage')::bigint,(h.fields->>'nativeCoverage')::bigint,false,
        (h.fields->>'acceptedAt')::timestamptz,true
      from pi_history_snapshots h join sessions s on s.tenant_id=h.tenant_id and s.id=h.session_id
      where h.kind='turn' and s.pruned_at is null;
    alter table pi_durable_log rename to pi_durable_writes;
    alter table pi_durable_writes alter column body drop not null;
    alter table pi_durable_writes add column entry_body_id uuid,
      add column entry_conversation_id bigint, add column entry_task_id bigint;
    alter table pi_durable_writes add foreign key(tenant_id,entry_body_id)
      references pi_history_bodies(tenant_id,id);
    create index pi_durable_entry_body_reference on pi_durable_writes(tenant_id,entry_body_id)
      where entry_body_id is not null;
    create function pi_native_entry_prefix(record_id bigint,conversation_id bigint,task_id bigint)
      returns text language sql immutable as $$
        select '{"type":"entry","value":{"id":'||record_id::text||',"conversationId":'||conversation_id::text||
          case when task_id is null then '' else ',"byTaskId":'||task_id::text end||','
      $$;
    create view pi_durable_log as
      select w.tenant_id,w.session_id,w.seq,w.ordinal,w.record_kind,w.record_id,
        case when w.record_kind='entry' then
          pi_native_entry_prefix(w.record_id,w.entry_conversation_id,w.entry_task_id)||substr(b.payload_text,2)||'}'
          else w.body end as body,
        w.phase,w.cloud_origin,
        case when w.record_kind='entry' then
          b.payload_bytes+octet_length(pi_native_entry_prefix(w.record_id,w.entry_conversation_id,w.entry_task_id))
          else octet_length(w.body) end as body_bytes,
        w.entry_body_id
      from pi_durable_writes w left join pi_history_bodies b
        on b.tenant_id=w.tenant_id and b.id=w.entry_body_id;
    create or replace view pi_durable_record_bodies as
      select tenant_id,session_id,seq,ordinal,record_kind,record_id,body,phase,cloud_origin from pi_durable_log
      union all select tenant_id,session_id,seq,ordinal,
        case when kind='document' then 'document.create' else kind end,
        id,body,null::text,cloud_origin from pi_durable_current;
  `.execute(database);
  // Bounded backfill preserves native JSON as TEXT, including NUL/lone surrogates.
  for (;;) {
    const { rows } = await sql<{
      tenant_id: string;
      session_id: string;
      seq: string;
      ordinal: number;
      body: string;
    }>`select tenant_id,session_id,seq::text,ordinal,body from pi_durable_writes
      where record_kind='entry' and entry_body_id is null
      order by tenant_id,session_id,seq,ordinal limit 64`.execute(database);
    if (!rows.length) break;
    for (const row of rows) {
      const write = JSON.parse(row.body);
      const { id: _id, conversationId, byTaskId, ...payload } = write.value;
      const text = JSON.stringify(payload),
        hash = createHash("sha256").update(text).digest("hex");
      const { rows: objects } = await sql<{ id: string }>`
        insert into pi_history_bodies(tenant_id,id,sha256,payload_text,payload_bytes)
        values(${row.tenant_id}::uuid,${randomUUID()}::uuid,${hash},${text},${Buffer.byteLength(text)})
        on conflict(tenant_id,body_kind,sha256) do update set sha256=excluded.sha256
          where pi_history_bodies.payload_text=excluded.payload_text returning id`.execute(
        database,
      );
      if (objects.length !== 1) throw new Error("Native Entry payload digest conflict");
      await sql`update pi_durable_writes set body=null,entry_body_id=${objects[0]!.id}::uuid,
        entry_conversation_id=${conversationId},entry_task_id=${byTaskId ?? null}
        where tenant_id=${row.tenant_id}::uuid and session_id=${row.session_id}
          and seq=${row.seq}::bigint and ordinal=${row.ordinal}`.execute(database);
    }
  }
  // Only the materialized-history checksum changes. Original Kafka batch fingerprints remain intact.
  let after: { tenant: string; session: string; seq: string } | undefined;
  for (;;) {
    const { rows } = await sql<{ tenant_id: string; session_id: string; seq: string }>`
      select tenant_id,session_id,seq::text from pi_durable_commits
      ${after ? sql`where (tenant_id,session_id,seq)>(${after.tenant}::uuid,${after.session},${after.seq}::bigint)` : sql``}
      order by tenant_id,session_id,seq limit 64`.execute(database);
    if (!rows.length) break;
    for (const row of rows) {
      const { rows: writes } = await sql<{
        ordinal: number;
        record_kind: string;
        record_id: string;
        body: string;
        phase: string | null;
        cloud_origin: Record<string, string> | null;
      }>`select ordinal,record_kind,record_id::text,body,phase,cloud_origin from pi_durable_log
        where tenant_id=${row.tenant_id}::uuid and session_id=${row.session_id} and seq=${row.seq}::bigint
        order by ordinal`.execute(database);
      const hash = createHash("sha256")
        .update(
          JSON.stringify(
            writes.map((w) => [
              w.ordinal,
              w.record_kind,
              String(w.record_id),
              w.body,
              w.phase,
              w.cloud_origin
                ? Object.fromEntries(
                    ["cloudSession", "run", "turn"]
                      .filter((k) => w.cloud_origin![k] !== undefined)
                      .map((k) => [k, w.cloud_origin![k]!]),
                  )
                : null,
            ]),
          ),
        )
        .digest("hex");
      await sql`update pi_durable_commits set history_fingerprint=${hash}
        where tenant_id=${row.tenant_id}::uuid and session_id=${row.session_id} and seq=${row.seq}::bigint`.execute(
        database,
      );
    }
    const last = rows.at(-1)!;
    after = { tenant: last.tenant_id, session: last.session_id, seq: last.seq };
  }
  await sql`alter table pi_durable_writes add constraint pi_durable_write_body_valid check(
    (record_kind='entry' and body is null and entry_body_id is not null and entry_conversation_id is not null)
    or (record_kind<>'entry' and body is not null and entry_body_id is null
      and entry_conversation_id is null and entry_task_id is null))`.execute(database);
  let documentAfter: { tenant: string; session: string; id: string } | undefined;
  for (;;) {
    const { rows } = await sql<{ tenant_id: string; session_id: string; id: string; body: string }>`
      select r.tenant_id,r.session_id,r.id::text,l.body from pi_durable_records r
      join lateral (select body from pi_durable_record_bodies b where b.tenant_id=r.tenant_id and b.session_id=r.session_id
        and b.seq=r.seq and b.ordinal=r.ordinal limit 1) l on true
      where r.kind='document'
        ${documentAfter ? sql`and (r.tenant_id,r.session_id,r.id)>(${documentAfter.tenant}::uuid,${documentAfter.session},${documentAfter.id}::bigint)` : sql``}
      order by r.tenant_id,r.session_id,r.id limit 64`.execute(database);
    if (!rows.length) break;
    for (const row of rows) {
      const record = JSON.parse(row.body).record;
      await sql`update pi_durable_records set fields=fields||${JSON.stringify({ forkPolicy: record.fork, historyPolicy: record.history })}::jsonb
        where tenant_id=${row.tenant_id}::uuid and session_id=${row.session_id} and id=${row.id}::bigint`.execute(
        database,
      );
    }
    const last = rows.at(-1)!;
    documentAfter = { tenant: last.tenant_id, session: last.session_id, id: last.id };
  }
}

export async function down(): Promise<void> {
  throw new Error("Restore a drained matched release from a verified logical export");
}
