import { sql, type Transaction } from "kysely";
import type { Database } from "@pi-cloud/database";

/** Metadata hints schedule bounded work; FK-backed roots and publication ranges
 * decide retention. A missing hint can never authorize deletion. */
export async function collectSharedHistory(
  tx: Transaction<Database>,
  limit: number,
): Promise<void> {
  await collectPresentation(tx, limit);
  let removed = 0;
  while (removed < limit) {
    const { rows } = await sql<{
      tenant_id: string;
      id: string;
    }>`select n.tenant_id,n.id from pi_history_nodes n
      where not exists(select 1 from pi_durable_bases b where b.tenant_id=n.tenant_id and b.entry_root=n.id)
        and not exists(select 1 from pi_history_nodes p where p.tenant_id=n.tenant_id and (p.left_id=n.id or p.right_id=n.id))
      order by n.tenant_id,n.id limit ${limit - removed} for update of n skip locked`.execute(tx);
    if (!rows.length) break;
    const deleted = await sql`with gone as (
      delete from pi_history_nodes n where (tenant_id,id) in(${sql.join(rows.map((r) => sql`(${r.tenant_id}::uuid,${r.id}::uuid)`))})
        and not exists(select 1 from pi_durable_bases b where b.tenant_id=n.tenant_id and b.entry_root=n.id)
        and not exists(select 1 from pi_history_nodes p where p.tenant_id=n.tenant_id and (p.left_id=n.id or p.right_id=n.id))
      returning tenant_id,source_id
    ), wake as (update pi_history_streams s set pending_gc=true from gone g where s.tenant_id=g.tenant_id and s.id=g.source_id)
      select * from gone`.execute(tx);
    if (!deleted.rows.length) break;
    removed += deleted.rows.length;
  }
  const { rows: streams } = await sql<{
    tenant_id: string;
    id: string;
    active: boolean;
  }>`select s.tenant_id,s.id,
    exists(select 1 from pi_sessions p where p.tenant_id=s.tenant_id and p.id=s.id) as active
    from pi_history_streams s where s.pending_gc order by s.tenant_id,s.id limit 16 for update of s skip locked`.execute(
    tx,
  );
  let remaining = limit;
  for (const stream of streams) {
    if (!remaining) break;
    const candidates = stream.active
      ? []
      : (
          await sql<{ id: string }>`select g.id from pi_history_records g
      where g.tenant_id=${stream.tenant_id}::uuid and g.session_id=${stream.id}
        and not exists(select 1 from pi_durable_write_refs r where r.tenant_id=g.tenant_id and r.retained_record_id=g.id)
        and not exists(select 1 from pi_history_frames f where f.tenant_id=g.tenant_id and (f.entry_record_id=g.id or f.assistant_record_id=g.id))
        and not exists(select 1 from pi_history_nodes n where n.tenant_id=g.tenant_id and n.source_id=g.session_id
          and g.record_kind='entry' and n.conversation_id=g.entry_conversation_id and g.record_id between n.min_id and n.max_id and g.seq<=n.through_seq)
      order by g.seq,g.ordinal limit ${remaining} for update of g skip locked`.execute(tx)
        ).rows;
    if (candidates.length) {
      // Re-evaluate references after acquiring locks. FK admission takes a record
      // key lock; new range admission holds the stream key lock above.
      await sql`delete from pi_history_records g where g.tenant_id=${stream.tenant_id}::uuid and g.id=any(${candidates.map((r) => r.id)}::uuid[])
        and not exists(select 1 from pi_durable_write_refs r where r.tenant_id=g.tenant_id and r.retained_record_id=g.id)
        and not exists(select 1 from pi_history_frames f where f.tenant_id=g.tenant_id and (f.entry_record_id=g.id or f.assistant_record_id=g.id))
        and not exists(select 1 from pi_history_nodes n where n.tenant_id=g.tenant_id and n.source_id=g.session_id
          and g.record_kind='entry' and n.conversation_id=g.entry_conversation_id and g.record_id between n.min_id and n.max_id and g.seq<=n.through_seq)`.execute(
        tx,
      );
    }
    remaining -= candidates.length;
    // A skipped locked record may lose its tentative new reference by rollback.
    // Keep the hint while any uncovered record remains, not just on a full batch.
    await sql`update pi_history_streams set pending_gc=case when ${stream.active} then false else exists(
      select 1 from pi_history_records g where g.tenant_id=${stream.tenant_id}::uuid and g.session_id=${stream.id}
        and not exists(select 1 from pi_durable_write_refs r where r.tenant_id=g.tenant_id and r.retained_record_id=g.id)
        and not exists(select 1 from pi_history_frames f where f.tenant_id=g.tenant_id and (f.entry_record_id=g.id or f.assistant_record_id=g.id))
        and not exists(select 1 from pi_history_nodes n where n.tenant_id=g.tenant_id and n.source_id=g.session_id
          and g.record_kind='entry' and n.conversation_id=g.entry_conversation_id and g.record_id between n.min_id and n.max_id and g.seq<=n.through_seq)
    ) end
      where tenant_id=${stream.tenant_id}::uuid and id=${stream.id}`.execute(tx);
    if (!stream.active)
      await sql`delete from pi_history_streams s where s.tenant_id=${stream.tenant_id}::uuid and s.id=${stream.id}
      and not exists(select 1 from pi_history_records g where g.tenant_id=s.tenant_id and g.session_id=s.id)
      and not exists(select 1 from pi_history_nodes n where n.tenant_id=s.tenant_id and n.source_id=s.id)`.execute(
        tx,
      );
  }
}

async function collectPresentation(tx: Transaction<Database>, limit: number): Promise<void> {
  let remaining = limit;
  while (remaining > 0) {
    const candidates = (
      await sql<{
        tenant_id: string;
        id: string;
      }>`select n.tenant_id,n.id from pi_history_view_nodes n
      where not exists(select 1 from pi_history_views v where v.tenant_id=n.tenant_id and v.root_id=n.id)
        and not exists(select 1 from pi_history_view_nodes p where p.tenant_id=n.tenant_id and (p.left_id=n.id or p.right_id=n.id))
      order by n.tenant_id,n.id limit ${remaining} for update of n skip locked`.execute(tx)
    ).rows;
    if (!candidates.length) break;
    const gone = (
      await sql`with removed as (
      delete from pi_history_view_nodes n where (tenant_id,id) in(${sql.join(candidates.map((r) => sql`(${r.tenant_id}::uuid,${r.id}::uuid)`))})
        and not exists(select 1 from pi_history_views v where v.tenant_id=n.tenant_id and v.root_id=n.id)
        and not exists(select 1 from pi_history_view_nodes p where p.tenant_id=n.tenant_id and (p.left_id=n.id or p.right_id=n.id))
      returning tenant_id,block_id
    ), wake as (update pi_history_blocks b set pending_gc=true from removed r where b.tenant_id=r.tenant_id and b.id=r.block_id)
      select * from removed`.execute(tx)
    ).rows;
    if (!gone.length) break;
    remaining -= gone.length;
  }
  const blocks = (
    await sql<{
      tenant_id: string;
      id: string;
      active: boolean;
    }>`select tenant_id,id,owner_pi_session_id is not null as active
    from pi_history_blocks where pending_gc order by tenant_id,id limit 16 for update skip locked`.execute(
      tx,
    )
  ).rows;
  remaining = limit;
  for (const block of blocks) {
    if (!remaining) break;
    const gone = block.active
      ? []
      : (
          await sql`with candidates as (
      select f.seq,f.ordinal from pi_history_frames f where f.tenant_id=${block.tenant_id}::uuid and f.block_id=${block.id}::uuid
        and not exists(select 1 from pi_history_view_nodes n where n.tenant_id=f.tenant_id and n.block_id=f.block_id and (f.seq,f.ordinal)<=(n.through_seq,n.through_ordinal))
      order by f.seq,f.ordinal limit ${remaining} for update of f skip locked
    ), removed as (delete from pi_history_frames f using candidates c
      where f.tenant_id=${block.tenant_id}::uuid and f.block_id=${block.id}::uuid and (f.seq,f.ordinal)=(c.seq,c.ordinal)
      returning f.entry_record_id,f.assistant_record_id
    ), wake as (update pi_history_streams s set pending_gc=true from pi_history_records g
      where g.tenant_id=${block.tenant_id}::uuid and g.id in(select entry_record_id from removed union select assistant_record_id from removed)
        and s.tenant_id=g.tenant_id and s.id=g.session_id)
    select * from removed`.execute(tx)
        ).rows;
    remaining -= gone.length;
    await sql`update pi_history_blocks set pending_gc=case when ${block.active} then false else exists(
      select 1 from pi_history_frames f where f.tenant_id=${block.tenant_id}::uuid and f.block_id=${block.id}::uuid
        and not exists(select 1 from pi_history_view_nodes n where n.tenant_id=f.tenant_id and n.block_id=f.block_id and (f.seq,f.ordinal)<=(n.through_seq,n.through_ordinal))
    ) end where tenant_id=${block.tenant_id}::uuid and id=${block.id}::uuid`.execute(tx);
    if (!block.active)
      await sql`delete from pi_history_blocks b where b.tenant_id=${block.tenant_id}::uuid and b.id=${block.id}::uuid
      and not exists(select 1 from pi_history_view_nodes n where n.tenant_id=b.tenant_id and n.block_id=b.id)
      and not exists(select 1 from pi_history_frames f where f.tenant_id=b.tenant_id and f.block_id=b.id)`.execute(
        tx,
      );
  }
}
