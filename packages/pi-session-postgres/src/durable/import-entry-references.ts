import { sql, type RawBuilder, type Transaction } from "kysely";
import type { Database } from "@pi-cloud/database";
import { retainSessionImages } from "@pi-cloud/session-attachments";
import type { DurableScope } from "./types.ts";

/** Private cold-import writer. Existing canonical payloads stay in PG; the
 * ordinary Worker commit path remains owned by DurablePostgresProjection. */
export async function importEntryReferences(
  tx: Transaction<Database>,
  input: {
    source: DurableScope;
    target: DurableScope;
    sourceSequence: number;
    afterOrdinal: number;
    sequence: number;
    nextId: number;
    selected: RawBuilder<unknown>;
  },
): Promise<{ count: number; lastOrdinal: number; hasMore: boolean }> {
  const { source, target } = input;
  if (source.tenantId !== target.tenantId || source.sessionId === target.sessionId)
    throw new Error("Reference import needs an independent Session in the same tenant");
  const { rows } = await sql<{
    expected: number;
    copied: number;
    indexed: number;
    valid: boolean;
    last_ordinal: number;
    has_more: boolean;
    image_bodies: string[];
  }>`with owner as materialized (
    select id from pi_sessions where tenant_id=${target.tenantId}::uuid and id=${target.sessionId} for update
  ), page as materialized (
    select l.* from pi_durable_writes l where l.tenant_id=${source.tenantId}::uuid and l.session_id=${source.sessionId}
      and l.seq=${input.sourceSequence} and l.ordinal>${input.afterOrdinal} and l.record_kind='entry' and ${input.selected}
    order by l.ordinal limit 33
  ), selected as materialized (
    select p.*,row_number()over(order by p.ordinal)::int-1 as new_ordinal,
      null::bigint as task_id,
      case when coalesce(p.cloud_origin->>'cloudSession','')<>'' and coalesce(p.cloud_origin->>'run','')<>'' and coalesce(p.cloud_origin->>'turn','')<>''
        then jsonb_build_object('cloudSession',p.cloud_origin->>'cloudSession','run',p.cloud_origin->>'run','turn',p.cloud_origin->>'turn') end as origin
    from page p order by p.ordinal limit 32
  ), refs as materialized (
    select p.*,r.fields from selected p
    join pi_durable_records r on r.tenant_id=p.tenant_id and r.session_id=p.session_id and r.id=p.record_id and r.kind='entry'
      and (r.seq,r.ordinal)=(p.seq,p.ordinal)
  ), bodies as materialized (
    select p.record_id,p.new_ordinal,p.origin,
      concat(pi_native_entry_prefix(p.record_id,p.entry_conversation_id,p.task_id),substr(b.payload_text,2),'}') as native_body,
      b.sha256=encode(sha256(convert_to(b.payload_text,'UTF8')),'hex') as valid_body,
      strpos(b.payload_text,'"pi_cloud_image_v1"')>0 as may_have_image,
      case when p.origin is null then 'null' else '{"cloudSession":'||to_json(p.origin->>'cloudSession')::text||
        ',"run":'||to_json(p.origin->>'run')::text||',"turn":'||to_json(p.origin->>'turn')::text||'}' end as origin_text
    from refs p join pi_history_bodies b on b.tenant_id=p.tenant_id and b.id=p.entry_body_id and b.body_kind='entry'
  ), manifest as (
    select coalesce(array_agg(native_body order by new_ordinal)filter(where may_have_image),'{}'::text[]) as image_bodies,
      count(*)::int as n,coalesce(bool_and(valid_body and record_id<${input.nextId}),true) as valid,
      coalesce(string_agg(native_body,',' order by new_ordinal),'') as writes,
      coalesce(string_agg('{"recordId":'||record_id::text||',"sessionId":'||to_json(origin->>'cloudSession')::text||
        ',"runId":'||to_json(origin->>'run')::text||',"turnId":'||to_json(origin->>'turn')::text||'}',',' order by new_ordinal)filter(where origin is not null),'') as origins,
      concat('[',coalesce(string_agg(concat('[',new_ordinal::text,',"entry",',to_json(record_id::text)::text,',',to_json(native_body)::text,',null,',origin_text,']'),',' order by new_ordinal),''),']') as history
    from bodies
  ), stamped as materialized (
    -- Materialize only the small digests, not repeated copies of the large preimages.
    select n,valid,image_bodies,
      encode(sha256(convert_to(concat('{"batch":{"seq":',${input.sequence}::text,',"nextId":',${input.nextId}::text,',"writes":[',writes,']},"origins":[',origins,']}'), 'UTF8')),'hex') as fingerprint,
      encode(sha256(convert_to(history,'UTF8')),'hex') as history_fingerprint
    from manifest
  ), commit_row as (
    insert into pi_durable_commits(tenant_id,session_id,seq,next_id,fingerprint,write_count,history_write_count,history_fingerprint,current_hashes,cloud_metadata)
    select ${target.tenantId}::uuid,${target.sessionId},${input.sequence},${input.nextId},
      m.fingerprint,m.n,m.n,m.history_fingerprint,'{}'::jsonb,null
    from owner,stamped m where m.n>0 and m.n=(select count(*) from selected) and m.valid
      and ${input.sequence}=coalesce((select seq+1 from pi_durable_commits where tenant_id=${target.tenantId}::uuid and session_id=${target.sessionId} order by seq desc limit 1),1)
      and ${input.nextId}>=coalesce((select next_id from pi_durable_commits where tenant_id=${target.tenantId}::uuid and session_id=${target.sessionId} order by seq desc limit 1),2)
      and not exists(select 1 from session_leases where tenant_id=${target.tenantId}::uuid and pi_session_id=${target.sessionId} and released_at is null)
    returning tenant_id,session_id,seq
  ), written as (
    insert into pi_durable_writes(tenant_id,session_id,seq,ordinal,record_kind,record_id,body,phase,cloud_origin,entry_body_id,entry_conversation_id,entry_task_id)
    select c.tenant_id,c.session_id,c.seq,b.new_ordinal,'entry',b.record_id,null,null,b.origin,b.entry_body_id,b.entry_conversation_id,b.task_id
    from commit_row c cross join refs b returning record_id,seq,ordinal
  ), indexed as (
    insert into pi_durable_records(tenant_id,session_id,id,kind,seq,ordinal,fields,created_seq,retired_seq)
    select ${target.tenantId}::uuid,${target.sessionId},w.record_id,'entry',w.seq,w.ordinal,
      (b.fields-'task'-'cloudSession'-'run'-'turn')||coalesce(b.origin,'{}'::jsonb),null,null
    from written w join refs b on b.record_id=w.record_id returning id
  ) select (select count(*)::int from selected) as expected,(select count(*)::int from written) as copied,
    (select count(*)::int from indexed) as indexed,m.valid,coalesce((select max(ordinal)::int from selected),-1) as last_ordinal,
    (select count(*)>32 from page) as has_more,
    m.image_bodies
  from stamped m`.execute(tx);
  const result = rows[0]!;
  if (!result.valid || result.copied !== result.expected || result.indexed !== result.expected)
    throw new Error("Native reference import failed its integrity, index or writer boundary");
  if (result.image_bodies.length)
    await retainSessionImages(
      tx,
      target,
      result.image_bodies.map((body) => JSON.parse(body)),
    );
  return { count: result.copied, lastOrdinal: result.last_ordinal, hasMore: result.has_more };
}
