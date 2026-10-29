import { sql, type Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import { retainedImageReferences } from "@pi-cloud/session-attachments";
import { captureNativePresentation } from "@pi-cloud/runtime-core/frozen-history";
import { appendPresentationBlock } from "@pi-cloud/runtime-core/presentation-directory";
import { settleHistoryTurn } from "@pi-cloud/runtime-core/presentation-settlement";

/** One-time matched bootstrap. It never runs on a read/Fork/Worker admission path. */
export async function upgradeSharedHistory(database: Kysely<Database>): Promise<void> {
  const pending = (
    await sql`select 1 from pi_sessions where history_bootstrap_pending
    union all select 1 from pi_history_records where not assets_indexed
    union all select 1 from pi_history_blocks where bootstrap_pending or not assets_indexed limit 1`.execute(
      database,
    )
  ).rows;
  if (!pending.length) return;
  const active = (
    await sql`select 1 from session_leases where released_at is null limit 1`.execute(database)
  ).rows;
  if (active.length) throw new Error("Drain writers before shared history bootstrap");
  for (;;) {
    const rows = (
      await sql<{ tenant_id: string; id: string; body: string | null }>`select g.tenant_id,g.id,
      case when g.record_kind='entry' and strpos(b.payload_text,'pi_cloud_image_v1')>0 then
        concat(pi_native_entry_prefix(g.record_id,g.entry_conversation_id,g.entry_task_id),substr(b.payload_text,2),'}')
        when g.record_kind<>'entry' and strpos(g.body,'pi_cloud_image_v1')>0 then g.body end as body
      from pi_history_records g left join pi_history_bodies b on b.tenant_id=g.tenant_id and b.id=g.entry_body_id
      where not g.assets_indexed order by g.tenant_id,g.session_id,g.seq,g.ordinal limit 64`.execute(
        database,
      )
    ).rows;
    if (!rows.length) break;
    await database.transaction().execute(async (tx) => {
      for (const row of rows) {
        const refs = row.body ? retainedImageReferences(JSON.parse(row.body)) : [];
        if (refs.length)
          await sql`insert into pi_history_record_images(tenant_id,retained_record_id,image_id)
          values ${sql.join(refs.map((r) => sql`(${row.tenant_id}::uuid,${row.id}::uuid,${r.id}::uuid)`))} on conflict do nothing`.execute(
            tx,
          );
      }
      await sql`update pi_history_records set assets_indexed=true where (tenant_id,id) in(${sql.join(rows.map((r) => sql`(${r.tenant_id}::uuid,${r.id}::uuid)`))})`.execute(
        tx,
      );
    });
  }
  for (;;) {
    const rows = (
      await sql<{
        tenant_id: string;
        id: string;
        payload_text: string;
        header_body_id: string;
      }>`select b.tenant_id,b.id,b.header_body_id,h.payload_text
      from pi_history_blocks b join pi_history_bodies h on h.tenant_id=b.tenant_id and h.id=b.header_body_id
      where not b.assets_indexed order by b.tenant_id,b.id limit 32`.execute(database)
    ).rows;
    if (!rows.length) break;
    for (const row of rows)
      await database.transaction().execute(async (tx) => {
        const header = JSON.parse(row.payload_text);
        const refs = (header.input_uploads ?? []).flatMap((u: { image?: unknown }) =>
          u.image
            ? retainedImageReferences({ type: "pi_cloud_image_v1", attachment: u.image })
            : [],
        );
        if (refs.length)
          await sql`insert into pi_history_header_images(tenant_id,body_id,image_id)
        values ${sql.join(refs.map((r: { id: string }) => sql`(${row.tenant_id}::uuid,${row.header_body_id}::uuid,${r.id}::uuid)`))} on conflict do nothing`.execute(
            tx,
          );
        let after = { seq: "-1", ordinal: -1 };
        for (;;) {
          const frames = (
            await sql<{
              seq: string;
              ordinal: number;
              entry_record_id: string;
              payload_text: string;
            }>`select f.seq::text,f.ordinal,f.entry_record_id,h.payload_text
          from pi_history_frames f join pi_history_bodies h on h.tenant_id=f.tenant_id and h.id=f.body_id
          where f.tenant_id=${row.tenant_id}::uuid and f.block_id=${row.id}::uuid and f.entry_record_id is not null
            and (f.seq,f.ordinal)>(${after.seq}::bigint,${after.ordinal}) and strpos(h.payload_text,'"image":')>0
          order by f.seq,f.ordinal limit 32`.execute(tx)
          ).rows;
          if (!frames.length) break;
          for (const frame of frames) {
            const value = JSON.parse(frame.payload_text);
            const images = (value.human?.uploads ?? []).flatMap((u: { image?: unknown }) =>
              u.image
                ? retainedImageReferences({ type: "pi_cloud_image_v1", attachment: u.image })
                : [],
            );
            if (images.length)
              await sql`insert into pi_history_record_images(tenant_id,retained_record_id,image_id)
            values ${sql.join(images.map((r: { id: string }) => sql`(${row.tenant_id}::uuid,${frame.entry_record_id}::uuid,${r.id}::uuid)`))} on conflict do nothing`.execute(
                tx,
              );
          }
          after = frames.at(-1)!;
        }
        await sql`update pi_history_blocks set assets_indexed=true where tenant_id=${row.tenant_id}::uuid and id=${row.id}::uuid`.execute(
          tx,
        );
      });
  }
  // Existing independently frozen prefixes already have complete frames. Attach
  // their roots before adding later local Turns, preserving original positions.
  const retained = (
    await sql<{
      tenant_id: string;
      source_session_id: string;
      id: string;
    }>`select b.tenant_id,b.source_session_id,b.id
    from pi_history_blocks b join sessions s on s.tenant_id=b.tenant_id and s.id=b.source_session_id
    where b.header_body_id is not null and b.bootstrap_pending and s.pruned_at is null order by b.tenant_id,b.source_session_id,b.position`.execute(
      database,
    )
  ).rows;
  for (const block of retained)
    await database.transaction().execute(async (tx) => {
      await appendPresentationBlock(tx, block.tenant_id, block.source_session_id, block.id);
      await sql`update pi_history_blocks set bootstrap_pending=false where tenant_id=${block.tenant_id}::uuid and id=${block.id}::uuid`.execute(
        tx,
      );
    });
  const turns = (
    await sql<{
      tenant_id: string;
      session_id: string;
      pi_session_id: string;
      turn_id: string;
    }>`select t.tenant_id,t.session_id,s.pi_session_id,t.turn_id
    from conversation_turns t join sessions s on s.tenant_id=t.tenant_id and s.id=t.session_id
    join pi_sessions p on p.tenant_id=s.tenant_id and p.id=s.pi_session_id and p.history_bootstrap_pending
    where t.pruned_at is null and s.pruned_at is null and t.state in ('completed','failed','cancelled','timed_out')
      and not(t.operation_kind='chat' and t.state='cancelled' and t.started_at is null)
      and not exists(select 1 from pi_history_blocks b where b.tenant_id=t.tenant_id and b.source_pi_session_id=s.pi_session_id and b.turn_id=t.turn_id and b.header_body_id is not null)
    order by t.tenant_id,t.session_id,t.mailbox_position`.execute(database)
  ).rows;
  for (const turn of turns)
    await database.transaction().execute(async (tx) => {
      const seqs = (
        await sql<{
          seq: string;
        }>`select distinct g.seq from pi_durable_write_refs r join pi_history_records g on g.tenant_id=r.tenant_id and g.id=r.retained_record_id
      where r.tenant_id=${turn.tenant_id}::uuid and r.session_id=${turn.pi_session_id} and not r.base and g.cloud_origin->>'turn'=${turn.turn_id}
      order by g.seq`.execute(tx)
      ).rows;
      for (const row of seqs)
        await captureNativePresentation(
          tx,
          { tenantId: turn.tenant_id, sessionId: turn.pi_session_id },
          Number(row.seq),
          turn.turn_id,
        );
      await settleHistoryTurn(tx, turn.tenant_id, turn.session_id, turn.turn_id);
    });
  await sql`update pi_sessions set history_bootstrap_pending=false where history_bootstrap_pending`.execute(
    database,
  );
  await sql`update pi_history_blocks set bootstrap_pending=false where bootstrap_pending`.execute(
    database,
  );
}
