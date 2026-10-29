import { sql, type Transaction } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  createSession,
  defineDoc,
  type ConversationId,
  type EntryId,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { FORK_PROVENANCE_DOCUMENT } from "@pi-cloud/protocol";
import { assertIdleNativeSession } from "../idle-session-mutation.ts";
import { HistoryDirectory } from "./history-directory.ts";
import { PostgresHistoryDirectory } from "./postgres-history-directory.ts";
import { readSharedBase, sharedStateFingerprint } from "./shared-history-base.ts";
import { DurablePostgresProjection } from "./postgres-projection.ts";
import { PublishedDurableStorage } from "./published-storage.ts";
import type { DurableScope, StoredDurableBatch } from "./types.ts";

type Range = { conversationId: number; through: number; sequence: number };
const ForkProvenanceDocument = defineDoc(FORK_PROVENANCE_DOCUMENT);
/** Snapshot import into a NEW cold physical Session. No source Harness/writer is opened. */
export async function importForkHistory(
  tx: Transaction<Database>,
  target: DurableScope,
  source: DurableScope & {
    conversationId: number;
    through: number;
    sourceProductSessionId: string;
  },
): Promise<{ conversationId: number; entryCount: number }> {
  if (target.tenantId !== source.tenantId || target.sessionId === source.sessionId)
    throw new Error("Fork must create an independent Session in the same tenant");
  await assertIdleNativeSession(tx, target.tenantId, target.sessionId);
  const destination = new DurablePostgresProjection(tx, target, undefined, "references");
  if ((await destination.head()).seq !== 0) throw new Error("Fork target is not empty");
  const original = new DurablePostgresProjection(tx, source, undefined, "references");
  const head = await original.head(); // Stable history can be copied while disposable pi.live is pending.
  const cutoff = (
    await sql<{
      kind: string;
      fields: Record<string, string>;
    }>`select kind,fields from pi_durable_records
    where tenant_id=${source.tenantId}::uuid and session_id=${source.sessionId} and id=${source.through}`.execute(
      tx,
    )
  ).rows[0];
  if (cutoff?.kind !== "entry") throw new Error("Fork cutoff is not a retained Entry");
  const ranges: Range[] = [];
  const sequenceCache = new Map<number, number>();
  for (const item of await original.conversationPath(source.conversationId, source.through)) {
    let sequence = sequenceCache.get(item.through);
    if (sequence === undefined) {
      sequence = await original.recordSequence(item.through);
      if (sequence === undefined) throw new Error("Fork ancestry cutoff is missing");
      sequenceCache.set(item.through, sequence);
    }
    ranges.push({ conversationId: item.record.value.id, through: item.through, sequence });
  }
  const cutoffConversation = Number(cutoff.fields.conversation);
  if (!ranges.some((r) => r.conversationId === cutoffConversation && r.through >= source.through))
    throw new Error("Fork cutoff is outside the visible ancestry");
  const conversationIds = [...new Set([1, ...ranges.map((r) => r.conversationId)])];
  const scopes = ranges.map((r) => JSON.stringify(["conversation", r.conversationId]));
  const { rows: definitions } = await sql<{
    id: string;
    scope: string;
    policy: string;
    created: string;
  }>`
    select id::text,fields->>'scope' as scope,fields->>'forkPolicy' as policy,created_seq::text as created
    from pi_durable_records r where r.tenant_id=${source.tenantId}::uuid and r.session_id=${source.sessionId}
      and r.kind='document' and r.fields->>'scope'=any(${scopes}::text[])
      and r.fields->>'forkPolicy' in ('asOf','current') and created_seq<=${head.seq}`.execute(tx);
  const byScope = new Map(
    ranges.map((r) => [JSON.stringify(["conversation", r.conversationId]), r]),
  );
  const documents = definitions.flatMap((d) => {
    const range = byScope.get(d.scope)!;
    const sequence =
      d.policy === "current" && range.conversationId === source.conversationId
        ? head.seq
        : range.sequence;
    return Number(d.created) <= sequence ? [{ id: d.id, sequence }] : [];
  });
  const adapter = new PostgresHistoryDirectory(tx, target.tenantId);
  const directory = new HistoryDirectory(adapter);
  const existingBase = await readSharedBase(tx, source);
  if (existingBase?.entry_root) await adapter.prefetch(existingBase.entry_root);
  let root = existingBase?.entry_root
    ? await directory.mapRanges(await directory.read(existingBase.entry_root), async (range) => {
        const maximum = ranges.find((r) => r.conversationId === range.conversationId)?.through;
        if (maximum === undefined) return undefined;
        const selected = range.maxId <= maximum ? range : await adapter.clip(range, maximum);
        return selected && !selected.clearTask ? { ...selected, clearTask: true } : selected;
      })
    : undefined;
  const ownedConversations = new Set(
    (
      await sql<{
        id: string;
      }>`select distinct entry_conversation_id::text as id from pi_history_records
    where tenant_id=${source.tenantId}::uuid and session_id=${source.sessionId} and record_kind='entry' and seq<=${head.seq}`.execute(
        tx,
      )
    ).rows.map((r) => Number(r.id)),
  );
  for (const range of [...ranges]
    .reverse()
    .filter((r) => ownedConversations.has(r.conversationId))) {
    const own = await adapter.range({
      sourceId: source.sessionId,
      conversationId: range.conversationId,
      throughSequence: head.seq,
      maximumId: range.through,
      clearTask: true,
    });
    if (own) root = await directory.join(root, directory.range(own));
  }
  if (!root) throw new Error("Fork has no retained entries");
  await directory.persist(root);
  // Only small native state references are installed per Fork. Entries retain
  // their immutable ranges and original publication positions through the root.
  await sql`insert into pi_durable_write_refs(tenant_id,session_id,seq,ordinal,retained_record_id,base,clear_owner)
    select ${target.tenantId}::uuid,${target.sessionId},l.seq,l.ordinal,l.retained_record_id,true,l.record_kind='conversation'
    from pi_durable_writes l where l.tenant_id=${source.tenantId}::uuid and l.session_id=${source.sessionId} and l.seq<=${head.seq}
      and ((l.record_kind='conversation' and l.record_id=any(${conversationIds}::bigint[]))
        or (l.record_kind in ('document.create','document.change','document.retire') and exists(
          select 1 from unnest(${documents.map((d) => d.id)}::bigint[],${documents.map((d) => d.sequence)}::bigint[]) d(id,through_seq)
          where l.record_id=d.id and l.seq<=d.through_seq)))`.execute(tx);
  const state = await sharedStateFingerprint(tx, target);
  await sql`insert into pi_durable_bases(tenant_id,session_id,through_seq,next_id,entry_root,entry_digest,history_count,history_fingerprint)
    values(${target.tenantId}::uuid,${target.sessionId},${head.seq},${head.nextId},${root.id}::uuid,${root.digest},${state.count}::bigint,${state.fingerprint})`.execute(
    tx,
  );
  await destination.initializeBaseIn(tx);
  const storage = await PublishedDurableStorage.open({
    projection: destination,
    publish: async (batch) => void (await destination.applyIn(tx, batch as StoredDurableBatch)),
    waitProjected: async () => {},
  });
  const session = createSession(storage);
  try {
    const fork = await session.commit(async (change) => {
      const provenance = await change.doc(ForkProvenanceDocument);
      const fork = await change.forkConversation(
        source.conversationId as ConversationId,
        source.through as EntryId,
        { ownership: { kind: "ownerless" } },
      );
      provenance.origin = {
        sessionId: target.sessionId,
        sourceSessionId: source.sourceProductSessionId,
        sourceEntryId: String(source.through),
      };
      return fork;
    }, BACKGROUND_CONTEXT);
    return { conversationId: fork.id, entryCount: root.count };
  } finally {
    await session.close(BACKGROUND_CONTEXT);
  }
}
