import { createHash } from "node:crypto";
import { sql, type Transaction } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  HistoryDirectory,
  type HistoryCoordinates,
  type HistoryDirectoryNode,
  type HistoryDirectoryStore,
} from "@pi-cloud/pi-session-postgres/durable";

export type PresentationRange = HistoryCoordinates &
  Readonly<{
    blockId: string;
    headerBodyId: string;
    headerFields: Record<string, unknown>;
    throughSequence: number;
    throughOrdinal: number;
    records: number;
  }>;
export type PresentationNode = HistoryDirectoryNode<PresentationRange>;
export class PostgresPresentationDirectory implements HistoryDirectoryStore<PresentationRange> {
  constructor(
    readonly database: Transaction<Database>,
    readonly tenantId: string,
  ) {}
  async read(id: string): Promise<PresentationNode | undefined> {
    const { rows } = await sql<{ node: PresentationNode }>`select node from pi_history_view_nodes
      where tenant_id=${this.tenantId}::uuid and id=${id}::uuid for key share`.execute(
      this.database,
    );
    return rows[0]?.node;
  }
  async insert(nodes: readonly PresentationNode[]): Promise<void> {
    if (!nodes.length) return;
    await sql`insert into pi_history_view_nodes(tenant_id,id,left_id,right_id,block_id,header_body_id,header_fields,through_seq,through_ordinal,min_position,max_position,turn_count,height,node)
      values ${sql.join(
        nodes.map(
          (n) => sql`(${this.tenantId}::uuid,${n.id}::uuid,
        ${n.kind === "branch" ? n.left : null}::uuid,${n.kind === "branch" ? n.right : null}::uuid,
        ${n.kind === "range" ? n.range.blockId : null}::uuid,${n.kind === "range" ? n.range.headerBodyId : null}::uuid,${n.kind === "range" ? JSON.stringify(n.range.headerFields) : null}::jsonb,${n.kind === "range" ? n.range.throughSequence : null}::bigint,
        ${n.kind === "range" ? n.range.throughOrdinal : null}::int,${n.minId},${n.maxId},${n.count},${n.height},${JSON.stringify(n)}::jsonb)`,
        ),
      )}`.execute(this.database);
  }
  async clip(range: PresentationRange, maximum: number): Promise<PresentationRange | undefined> {
    return range.minId <= maximum ? range : undefined;
  }
  async range(
    blockId: string,
    through?: { seq: number; ordinal: number },
    header?: Pick<PresentationRange, "headerBodyId" | "headerFields">,
  ): Promise<PresentationRange> {
    const block = (
      await sql<{
        position: string;
        header_body_id: string;
        fields: Record<string, unknown>;
      }>`select position::text,header_body_id,fields from pi_history_blocks
      where tenant_id=${this.tenantId}::uuid and id=${blockId}::uuid and header_body_id is not null for key share`.execute(
        this.database,
      )
    ).rows[0];
    if (!block) throw new Error("Retained presentation header is missing");
    const count = (
      await sql<{ n: string; seq: string | null; ordinal: number | null }>`with visible as (
      select seq,ordinal from pi_history_frames where tenant_id=${this.tenantId}::uuid and block_id=${blockId}::uuid
        ${through ? sql`and (seq,ordinal)<=(${through.seq},${through.ordinal})` : sql``}
    ) select count(*)::text as n,(array_agg(seq order by seq desc,ordinal desc))[1]::text as seq,
      (array_agg(ordinal order by seq desc,ordinal desc))[1] as ordinal from visible`.execute(
        this.database,
      )
    ).rows[0]!;
    const seq = through?.seq ?? Number(count.seq ?? 0),
      ordinal = through?.ordinal ?? count.ordinal ?? 0;
    const fields = header?.headerFields ?? block.fields;
    const fieldsKey = Object.fromEntries(
      Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    return {
      blockId,
      headerBodyId: header?.headerBodyId ?? block.header_body_id,
      headerFields: fields,
      throughSequence: seq,
      throughOrdinal: ordinal,
      minId: Number(block.position),
      maxId: Number(block.position),
      count: 1,
      records: Number(count.n),
      fingerprint: createHash("sha256")
        .update(
          JSON.stringify([
            blockId,
            header?.headerBodyId ?? block.header_body_id,
            seq,
            ordinal,
            Number(count.n),
            fieldsKey,
          ]),
        )
        .digest("hex"),
    };
  }
}

export async function appendPresentationBlock(
  tx: Transaction<Database>,
  tenantId: string,
  sessionId: string,
  blockId: string,
): Promise<void> {
  const adapter = new PostgresPresentationDirectory(tx, tenantId),
    directory = new HistoryDirectory(adapter);
  const existing = (
    await sql<{ root_id: string }>`select root_id from pi_history_views
    where tenant_id=${tenantId}::uuid and session_id=${sessionId}::uuid for update`.execute(tx)
  ).rows[0];
  const root = existing ? await directory.read(existing.root_id) : undefined;
  const range = await adapter.range(blockId);
  if (root && root.maxId >= range.minId) {
    const visible = (
      await sql`select 1 from pi_history_view_ranges(${tenantId}::uuid,${root.id}::uuid,${range.minId},${range.maxId})
      where block_id=${blockId}::uuid limit 1`.execute(tx)
    ).rows;
    if (visible.length) {
      const next = await directory.mapRanges(root, async (prior) =>
        prior.blockId !== blockId || prior.fingerprint === range.fingerprint ? prior : range,
      );
      await directory.persist(next);
      if (next!.id !== root.id)
        await sql`update pi_history_views set root_id=${next!.id}::uuid where tenant_id=${tenantId}::uuid and session_id=${sessionId}::uuid`.execute(
          tx,
        );
      return;
    }
    throw new Error("Retained presentation order changed");
  }
  const next = await directory.join(root, directory.range(range));
  await directory.persist(next);
  await sql`insert into pi_history_views(tenant_id,session_id,root_id) values(${tenantId}::uuid,${sessionId}::uuid,${next!.id}::uuid)
    on conflict(tenant_id,session_id) do update set root_id=excluded.root_id`.execute(tx);
}
