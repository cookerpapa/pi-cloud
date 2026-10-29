import { createHash, randomUUID } from "node:crypto";
import { sql, type Transaction, type Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import type { StorageWrite } from "@earendil-works/pi-durable";
import type { DurableScope } from "./types.ts";
import type { HistoryWriteRow } from "./current-state.ts";
import { indexNative } from "./types.ts";
import { retainedImageReferences } from "@pi-cloud/session-attachments";
import { collectSharedHistory } from "./history-collection.ts";

type EntryWrite = Extract<StorageWrite, { type: "entry" }>;

function splitEntry(write: EntryWrite) {
  const { id, conversationId, byTaskId, ...payload } = write.value;
  const text = JSON.stringify(payload);
  return {
    id,
    conversationId,
    byTaskId: byTaskId ?? null,
    text,
    digest: createHash("sha256").update(text).digest("hex"),
  };
}

/** PG's logical body has a stable identity envelope; native batch bytes stay unchanged. */
export function retainedHistoryBody(write: StorageWrite): string {
  if (write.type !== "entry") return JSON.stringify(write);
  const entry = splitEntry(write);
  return (
    `{"type":"entry","value":{"id":${entry.id},"conversationId":${entry.conversationId}` +
    (entry.byTaskId === null ? "" : `,"byTaskId":${entry.byTaskId}`) +
    `,${entry.text.slice(1)}}`
  );
}

/** One immutable payload object may back entries in independently owned Sessions. */
export async function writeRetainedHistory(
  tx: Transaction<Database>,
  scope: DurableScope,
  seq: number,
  history: readonly HistoryWriteRow[],
): Promise<void> {
  if (!history.length) return;
  const entries = new Map<number, ReturnType<typeof splitEntry>>();
  const fields = new Map<number, Record<string, string>>();
  const images: { ordinal: number; imageId: string }[] = [];
  const payloads = new Map<string, { id: string; text: string }>();
  for (const row of history) {
    const write = JSON.parse(row.body) as StorageWrite;
    for (const ref of retainedImageReferences(write))
      images.push({ ordinal: row.ordinal, imageId: ref.id });
    if (row.record_kind !== "entry") continue;
    const entry = splitEntry(write as EntryWrite);
    fields.set(row.ordinal, {
      ...indexNative("entry", (write as EntryWrite).value, seq, row.ordinal).fields,
      ...(row.cloud_origin ?? {}),
    });
    entries.set(row.ordinal, entry);
    const previous = payloads.get(entry.digest);
    if (previous && previous.text !== entry.text)
      throw new Error("Native Entry payload digest conflict");
    if (!previous) payloads.set(entry.digest, { id: randomUUID(), text: entry.text });
  }
  // Intern bodies and install references in one SQL round trip. The conflict lock
  // protects in-flight references; the write-body CHECK rejects a digest mismatch.
  const objects = payloads.size
    ? sql`insert into pi_history_bodies(tenant_id,id,sha256,payload_text,payload_bytes)
    values ${sql.join([...payloads].sort(([a], [b]) => a.localeCompare(b)).map(([hash, v]) => sql`(${scope.tenantId}::uuid,${v.id}::uuid,${hash},${v.text},${Buffer.byteLength(v.text)})`))}
    on conflict(tenant_id,body_kind,sha256) do update set sha256=excluded.sha256
      where pi_history_bodies.payload_text=excluded.payload_text returning id,sha256`
    : sql`select null::uuid as id,null::text as sha256 where false`;
  await sql`with stream as (
    insert into pi_history_streams(tenant_id,id) values(${scope.tenantId}::uuid,${scope.sessionId}) on conflict do nothing
  ), bodies as (${objects}), writes(ordinal,record_kind,record_id,body,phase,cloud_origin,digest,conversation_id,task_id,fields) as (
    values ${sql.join(
      history.map((row) => {
        const e = entries.get(row.ordinal);
        return sql`(${row.ordinal}::int,${row.record_kind}::text,${row.record_id}::bigint,${e ? null : row.body}::text,${row.phase}::text,
        ${row.cloud_origin === null ? null : JSON.stringify(row.cloud_origin)}::jsonb,${e?.digest ?? null}::text,
        ${e?.conversationId ?? null}::bigint,${e?.byTaskId ?? null}::bigint,${JSON.stringify(fields.get(row.ordinal) ?? {})}::jsonb)`;
      }),
    )}), retained as (
    insert into pi_history_records(tenant_id,session_id,seq,ordinal,record_kind,record_id,body,phase,cloud_origin,
      entry_body_id,entry_conversation_id,entry_task_id,committed_at,fields)
    select ${scope.tenantId}::uuid,${scope.sessionId},${seq},w.ordinal,w.record_kind,w.record_id,w.body,w.phase,w.cloud_origin,
      b.id,w.conversation_id,w.task_id,
      (select committed_at from pi_durable_commits where tenant_id=${scope.tenantId}::uuid and session_id=${scope.sessionId} and seq=${seq}),w.fields
      from writes w left join bodies b on b.sha256=w.digest
      returning tenant_id,session_id,seq,ordinal,id
    ), image_refs as (
      ${
        images.length
          ? sql`insert into pi_history_record_images(tenant_id,retained_record_id,image_id)
        select r.tenant_id,r.id,v.image_id from retained r join (values ${sql.join(images.map((v) => sql`(${v.ordinal}::int,${v.imageId}::uuid)`))}) v(ordinal,image_id) using(ordinal)
        on conflict do nothing`
          : sql`select 1`
      }
    ) insert into pi_durable_write_refs(tenant_id,session_id,seq,ordinal,retained_record_id)
      select tenant_id,session_id,seq,ordinal,id from retained`.execute(tx);
}

/** Only unreferenced PG objects; retiring native histories is a separate guarded operation. */
export async function reapUnreferencedEntryBodies(
  database: Kysely<Database>,
  limit = 64,
): Promise<number> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1024)
    throw new Error("Invalid Entry body cleanup batch");
  return database.transaction().execute(async (tx) => {
    await collectSharedHistory(tx, limit);
    const { rows } = await sql<{ tenant_id: string; id: string }>`
      select b.tenant_id,b.id from pi_history_bodies b
      where not exists(select 1 from pi_history_records w
        where w.tenant_id=b.tenant_id and w.entry_body_id=b.id)
        and not exists(select 1 from pi_history_frames f where f.tenant_id=b.tenant_id and f.body_id=b.id)
        and not exists(select 1 from pi_history_blocks h where h.tenant_id=b.tenant_id and h.header_body_id=b.id)
        and not exists(select 1 from pi_history_view_nodes n where n.tenant_id=b.tenant_id and n.header_body_id=b.id)

      order by b.tenant_id,b.id limit ${limit} for update of b skip locked`.execute(tx);
    if (!rows.length) return 0;
    const deleted = await sql`delete from pi_history_bodies b
      where (tenant_id,id) in (${sql.join(rows.map((r) => sql`(${r.tenant_id}::uuid,${r.id}::uuid)`))})
        and not exists(select 1 from pi_history_records w
          where w.tenant_id=b.tenant_id and w.entry_body_id=b.id)
        and not exists(select 1 from pi_history_frames f where f.tenant_id=b.tenant_id and f.body_id=b.id)
        and not exists(select 1 from pi_history_blocks h where h.tenant_id=b.tenant_id and h.header_body_id=b.id)
        and not exists(select 1 from pi_history_view_nodes n where n.tenant_id=b.tenant_id and n.header_body_id=b.id)

      returning id`.execute(tx);
    return deleted.rows.length;
  });
}
