import { sql, type Transaction } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  createSession,
  defineDoc,
  type ConversationId,
  type ConversationRecord,
  type EntryId,
  type Seq,
  type StorageWrite,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { FORK_PROVENANCE_DOCUMENT } from "@pi-cloud/protocol";
import { assertIdleNativeSession } from "../idle-session-mutation.ts";
import { importEntryReferences } from "./import-entry-references.ts";
import { DurablePostgresProjection } from "./postgres-projection.ts";
import { PublishedDurableStorage } from "./published-storage.ts";
import type { DurableScope, StoredDurableBatch } from "./types.ts";

type Range = { conversationId: number; through: number; sequence: number };
const ForkProvenanceDocument = defineDoc(FORK_PROVENANCE_DOCUMENT);
type Row = {
  ordinal: number;
  record_id: string;
  body: string;
  cloud_origin: Record<string, string> | null;
};

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
  const cutoff = await original.get(source.through);
  if (cutoff?.kind !== "entry") throw new Error("Fork cutoff is not a retained Entry");
  const ranges: Range[] = [];
  const seen = new Set<number>();
  let conversationId = source.conversationId,
    through = source.through;
  for (;;) {
    if (seen.has(conversationId)) throw new Error("Fork ancestry contains a cycle");
    seen.add(conversationId);
    const stored = await original.get(conversationId);
    if (stored?.kind !== "conversation") throw new Error("Fork source Conversation is missing");
    const point = await original.get(through);
    if (point?.kind !== "entry") throw new Error("Fork ancestry cutoff is missing");
    ranges.push({ conversationId, through, sequence: point.seq });
    const parent = (stored.value as ConversationRecord).parent;
    if (!parent) break;
    through = Math.min(through, parent.at);
    conversationId = parent.conversationId;
  }
  const cutoffConversation = (cutoff.value as { conversationId: number }).conversationId;
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
  const documents = definitions.flatMap((d) => {
    const range = ranges.find(
      (r) => d.scope === JSON.stringify(["conversation", r.conversationId]),
    )!;
    const sequence =
      d.policy === "current" && range.conversationId === source.conversationId
        ? head.seq
        : range.sequence;
    return Number(d.created) <= sequence ? [{ id: d.id, sequence }] : [];
  });
  const selected = sql`(
    (l.record_kind='conversation' and l.record_id=any(${conversationIds}::bigint[]))
    or (l.record_kind='entry' and exists(
      select 1 from pi_durable_records r
      join unnest(${ranges.map((r) => r.conversationId)}::bigint[],${ranges.map((r) => r.through)}::bigint[]) p(conversation_id,through_id)
        on r.fields->>'conversation'=p.conversation_id::text and r.id<=p.through_id
      where r.tenant_id=l.tenant_id and r.session_id=l.session_id and r.id=l.record_id and r.kind='entry'))
    or (l.record_kind in ('document.create','document.change','document.retire') and exists(
      select 1 from unnest(${documents.map((d) => d.id)}::bigint[],${documents.map((d) => d.sequence)}::bigint[]) d(id,through_seq)
      where l.record_id=d.id and l.seq<=d.through_seq))
  )`;
  let seq = 0,
    entries = 0;
  const publish = async (rows: readonly Row[]) => {
    if (!rows.length) return;
    const writes = rows.map((row) => {
      const write = JSON.parse(row.body) as StorageWrite;
      if (write.type === "conversation") {
        const { owner: _owner, ...value } = write.value;
        return { type: "conversation", value } as StorageWrite;
      }
      return write;
    });
    await destination.applyIn(tx, {
      seq: ++seq as Seq,
      nextId: head.nextId,
      writes,
    } as StoredDurableBatch);
  };
  let afterSeq = 0;
  for (;;) {
    const { rows: commits } = await sql<{
      seq: string;
      has_state: boolean;
    }>`select l.seq,bool_or(l.record_kind<>'entry') as has_state from pi_durable_writes l
      where l.tenant_id=${source.tenantId}::uuid and l.session_id=${source.sessionId}
        and l.seq>${afterSeq} and l.seq<=${head.seq} and ${selected}
      group by l.seq order by l.seq limit 64`.execute(tx);
    if (!commits.length) break;
    for (const commit of commits) {
      // All document changes from an original commit precede its copied Entries.
      // Splitting Entry pages then preserves every native asOf commit boundary.
      const { rows: state } = commit.has_state
        ? await sql<Row>`select l.ordinal,l.record_id::text,l.body,l.cloud_origin
        from pi_durable_log l where l.tenant_id=${source.tenantId}::uuid and l.session_id=${source.sessionId}
          and l.seq=${commit.seq}::bigint and l.record_kind<>'entry' and ${selected}
        order by l.ordinal`.execute(tx)
        : { rows: [] };
      await publish(state);
      let ordinal = -1;
      for (;;) {
        const copied = await importEntryReferences(tx, {
          source,
          target,
          sourceSequence: Number(commit.seq),
          afterOrdinal: ordinal,
          sequence: seq + 1,
          nextId: head.nextId,
          selected,
        });
        if (!copied.count) break;
        seq++;
        entries += copied.count;
        ordinal = copied.lastOrdinal;
        if (!copied.hasMore) break;
      }
      afterSeq = Number(commit.seq);
    }
  }
  if (!entries) throw new Error("Fork has no retained entries");
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
    return { conversationId: fork.id, entryCount: entries };
  } finally {
    await session.close(BACKGROUND_CONTEXT);
  }
}
