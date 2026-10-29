import { createHash, randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { Database } from "@pi-cloud/database";
import { retainSessionImages, retainedImageReferences } from "@pi-cloud/session-attachments";
import { appendPresentationBlock } from "./presentation-directory.ts";
import type { HistoryHeader } from "./frozen-history.ts";

/** Called in the ordered terminal projection transaction, after counters/state.
 * It fixes a frame prefix and immutable header; no model body is traversed or copied here. */
export async function settleHistoryTurn(
  tx: Transaction<Database>,
  tenantId: string,
  sessionId: string,
  turnId: string,
): Promise<void> {
  const row = (
    await sql<{
      pi_session_id: string;
      run_id: string;
      position: string;
      state: string;
      stop_reason: string | null;
      operation_kind: string;
      coverage: string;
      native_coverage: string;
      created_at: Date;
      header: HistoryHeader;
    }>`select s.pi_session_id,r.id as run_id,r.mailbox_position::text as position,r.state,r.stop_reason,r.operation_kind,
      r.output_display_seq::text as coverage,r.output_display_native_seq::text as native_coverage,r.created_at,
      jsonb_build_object('input_text',r.input_text,'input_source',r.input_source,'input_uploads',r.input_uploads,'scheduled_origin',r.scheduled_origin,
        'output_display_seq',r.output_display_seq::text,'terminal',case when e.turn_id is not null then
          jsonb_build_object('seq',e.seq::text,'type',e.type,'payload',e.payload,'occurred_at',e.occurred_at) end) as header
    from conversation_turns r join sessions s on s.tenant_id=r.tenant_id and s.id=r.session_id
    left join lateral(select * from session_terminal_events e where e.tenant_id=r.tenant_id and e.turn_id=r.turn_id order by e.seq desc limit 1) e on true
    where r.tenant_id=${tenantId}::uuid and r.session_id=${sessionId}::uuid and r.turn_id=${turnId}::uuid
      and r.pruned_at is null and s.pruned_at is null and r.state in ('completed','failed','cancelled','timed_out')
      and not(r.output_seal_id is not null and r.output_sealed_at is null)
      and not(r.operation_kind='chat' and r.state='cancelled' and r.started_at is null)`.execute(tx)
  ).rows[0];
  if (!row) return;
  const retained = (
    await sql`select 1 from pi_history_views v
    cross join lateral pi_history_view_ranges(v.tenant_id,v.root_id,${row.position}::bigint,${row.position}::bigint) n
    join pi_history_blocks b on b.tenant_id=v.tenant_id and b.id=n.block_id
    where v.tenant_id=${tenantId}::uuid and v.session_id=${sessionId}::uuid and b.turn_id=${turnId}::uuid limit 1`.execute(
      tx,
    )
  ).rows;
  if (retained.length) {
    const historical = (
      await sql`select 1 from pi_history_views v
      cross join lateral pi_history_view_ranges(v.tenant_id,v.root_id,${row.position}::bigint,${row.position}::bigint) n
      join pi_history_blocks b on b.tenant_id=v.tenant_id and b.id=n.block_id
      where v.tenant_id=${tenantId}::uuid and v.session_id=${sessionId}::uuid and b.turn_id=${turnId}::uuid
        and (b.source_session_id<>${sessionId}::uuid or b.source_pi_session_id<>${row.pi_session_id}) limit 1`.execute(
        tx,
      )
    ).rows;
    if (historical.length) return;
  }
  const block = (
    await sql<{
      id: string;
    }>`insert into pi_history_blocks(tenant_id,source_session_id,source_pi_session_id,owner_pi_session_id,turn_id,origin_session_id,position)
    values(${tenantId}::uuid,${sessionId}::uuid,${row.pi_session_id},${row.pi_session_id},${turnId}::uuid,${sessionId}::uuid,${row.position}::bigint)
    on conflict(tenant_id,source_pi_session_id,turn_id) do update set source_session_id=excluded.source_session_id returning id`.execute(
      tx,
    )
  ).rows[0]!;
  {
    const text = JSON.stringify(row.header),
      hash = createHash("sha256").update(text).digest("hex");
    const body = (
      await sql<{
        id: string;
      }>`insert into pi_history_bodies(tenant_id,id,body_kind,sha256,payload_text,payload_bytes)
      values(${tenantId}::uuid,${randomUUID()}::uuid,'metadata',${hash},${text},${Buffer.byteLength(text)})
      on conflict(tenant_id,body_kind,sha256) do update set sha256=excluded.sha256 where pi_history_bodies.payload_text=excluded.payload_text returning id`.execute(
        tx,
      )
    ).rows[0];
    if (!body) throw new Error("Retained header digest conflict");
    const fields = {
      runId: row.run_id,
      operationKind: row.operation_kind,
      runState: row.state,
      stopReason: row.stop_reason,
      coverage: row.coverage,
      nativeCoverage: row.native_coverage,
      acceptedAt: new Date(row.created_at).toISOString(),
    };
    const images = (row.header.input_uploads ?? []).flatMap((value) => {
      const upload = value as { image?: unknown };
      return upload.image
        ? retainedImageReferences({ type: "pi_cloud_image_v1", attachment: upload.image })
        : [];
    });
    if (images.length) {
      await retainSessionImages(
        tx,
        { tenantId, sessionId: row.pi_session_id },
        images.map((attachment) => ({ type: "pi_cloud_image_v1", attachment })),
      );
      await sql`insert into pi_history_header_images(tenant_id,body_id,image_id)
        values ${sql.join(images.map((image) => sql`(${tenantId}::uuid,${body.id}::uuid,${image.id}::uuid)`))} on conflict do nothing`.execute(
        tx,
      );
    }
    await sql`update pi_history_blocks set header_body_id=${body.id}::uuid,fields=${JSON.stringify(fields)}::jsonb
      where tenant_id=${tenantId}::uuid and id=${block.id}::uuid`.execute(tx);
  }
  await appendPresentationBlock(tx, tenantId, sessionId, block.id);
}

export async function settleFamilyHistory(
  tx: Transaction<Database>,
  tenantId: string,
  runId: string,
): Promise<void> {
  const rows = (
    await sql<{
      session_id: string;
      turn_id: string;
    }>`select session_id,turn_id from pi_history_live_turns
    where tenant_id=${tenantId}::uuid and run_id=${runId}::uuid and state in ('completed','failed','cancelled','timed_out') and not waiting_for_seal
    order by session_id,mailbox_position`.execute(tx)
  ).rows;
  for (const row of rows) await settleHistoryTurn(tx, tenantId, row.session_id, row.turn_id);
}
