import { sql, type Transaction } from "kysely";
import type { Database } from "@pi-cloud/database";
import type { DurableScope } from "./types.ts";
import { HistoryDirectory, type HistoryDirectoryNode } from "./history-directory.ts";
import { PostgresHistoryDirectory } from "./postgres-history-directory.ts";

export type SharedHistoryBase = {
  through_seq: string;
  next_id: string;
  entry_root: string | null;
  entry_digest: string | null;
  history_count: string;
  history_fingerprint: string;
  current_hashes: Record<string, { seq: string; hash: string }>;
};
export async function readSharedBase(
  tx: Transaction<Database>,
  scope: DurableScope,
): Promise<SharedHistoryBase | undefined> {
  const { rows } = await sql<SharedHistoryBase>`select * from pi_durable_bases
    where tenant_id=${scope.tenantId}::uuid and session_id=${scope.sessionId}`.execute(tx);
  return rows[0];
}

export async function sharedStateFingerprint(tx: Transaction<Database>, scope: DurableScope) {
  const { rows } = await sql<{ count: string; fingerprint: string }>`select count(*)::text as count,
    encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(jsonb_build_array(r.seq,r.ordinal,r.retained_record_id,r.clear_owner,g.record_kind,g.record_id,g.body,g.cloud_origin)::text,'UTF8')),'hex'),'' order by r.seq,r.ordinal),''),'UTF8')),'hex') as fingerprint
    from pi_durable_write_refs r join pi_history_records g on g.tenant_id=r.tenant_id and g.id=r.retained_record_id
    where r.tenant_id=${scope.tenantId}::uuid and r.session_id=${scope.sessionId} and r.base`.execute(
    tx,
  );
  return rows[0]!;
}

/** Explicit cold integrity rebuild only. Ordinary Fork admission never hashes old message bodies. */
export async function verifySharedEntries(
  tx: Transaction<Database>,
  scope: DurableScope,
  base: SharedHistoryBase,
): Promise<void> {
  if (!base.entry_root) {
    if (base.entry_digest !== null) throw new Error("Shared history root integrity check failed");
    return;
  }
  const adapter = new PostgresHistoryDirectory(tx, scope.tenantId),
    directory = new HistoryDirectory(adapter);
  await adapter.prefetch(base.entry_root);
  const root = await directory.read(base.entry_root);
  if (root.digest !== base.entry_digest)
    throw new Error("Shared history root integrity check failed");
  const visit = async (node: HistoryDirectoryNode): Promise<void> => {
    if (node.kind === "branch") {
      const left = await directory.read(node.left),
        right = await directory.read(node.right);
      if (
        left.digest !== node.leftDigest ||
        right.digest !== node.rightDigest ||
        left.count + right.count !== node.count
      )
        throw new Error("Shared history directory integrity check failed");
      await visit(left);
      await visit(right);
      return;
    }
    const actual = await adapter.clip(node.range, node.maxId);
    if (!actual || actual.count !== node.count || actual.fingerprint !== node.range.fingerprint)
      throw new Error("Shared history range integrity check failed");
    const { rows } =
      await sql`select 1 from pi_history_records g join pi_history_bodies b on b.tenant_id=g.tenant_id and b.id=g.entry_body_id
      where g.tenant_id=${scope.tenantId}::uuid and g.session_id=${node.range.sourceId}
        and g.record_kind='entry' and g.entry_conversation_id=${node.range.conversationId}
        and g.record_id between ${node.minId} and ${node.maxId} and g.seq<=${node.range.throughSequence}
        and b.sha256<>encode(sha256(convert_to(b.payload_text,'UTF8')),'hex') limit 1`.execute(tx);
    if (rows.length) throw new Error("Shared native Entry body integrity check failed");
  };
  await visit(root);
}
