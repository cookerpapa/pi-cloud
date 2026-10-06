import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "@pi-cloud/database";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createSession,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type ConversationRecord,
  type Seq,
  type StorageWrite,
  type Cursor,
  type DocumentId,
  type DocumentPoint,
} from "@earendil-works/pi-durable";
import type { DurableRecordOrigin, ImagePacked } from "@pi-cloud/protocol";
import { assertIdleNativeSession } from "../idle-session-mutation.ts";
import { PublishedDurableStorage } from "./published-storage.ts";
import { DurablePostgresProjection } from "./postgres-projection.ts";
import type { DurableScope, StoredDurableBatch } from "./types.ts";

export type StoredHistoryEntry = {
  entry: ImagePacked<EntryRecord>;
  turnId: string | null;
  runId: string | null;
  sessionId: string | null;
  seq: number;
  createdAt: string;
};
type HistoryRow = { body: string; fields: Record<string, string>; seq: string; committed_at: Date };
function historyEntry(row: HistoryRow): StoredHistoryEntry {
  return {
    entry: (JSON.parse(row.body) as { value: ImagePacked<EntryRecord> }).value,
    turnId: row.fields.turn ?? null,
    runId: row.fields.run ?? null,
    sessionId: row.fields.cloudSession ?? null,
    seq: Number(row.seq),
    createdAt: new Date(row.committed_at).toISOString(),
  };
}

/** Presentation reads keep image references opaque; only the trusted Runner
 * materializes pixels. Each ancestry range uses the conversation/ID index. */
export async function readDurableEntries(
  database: Kysely<Database>,
  input: DurableScope & {
    conversationId: number;
    through?: number;
    from?: number;
    limit: number;
    activeOnly?: boolean;
    navigationOnly?: boolean;
    includeEntryIds?: readonly number[];
  },
): Promise<StoredHistoryEntry[]> {
  const projection = new DurablePostgresProjection(database, input, undefined, "references");
  const rows: StoredHistoryEntry[] = [],
    visited = new Set<number>();
  let conversationId = input.conversationId,
    through = input.through ?? Number.MAX_SAFE_INTEGER;
  let head: number | undefined;
  while (rows.length < input.limit) {
    if (visited.has(conversationId))
      throw new Error("Native conversation ancestry contains a cycle");
    visited.add(conversationId);
    const record = await projection.get(conversationId);
    if (!record) break;
    if (record.kind !== "conversation") throw new Error("Invalid native conversation binding");
    const conversation = record.value as ConversationRecord;
    let pageThrough = through;
    while (rows.length < input.limit) {
      const count = Math.min(64, input.limit - rows.length);
      const page = await sql<HistoryRow>`
      select l.body,r.fields,r.seq,c.committed_at
      from pi_durable_records r join pi_durable_log l using(tenant_id,session_id,seq,ordinal)
        join pi_durable_commits c using(tenant_id,session_id,seq)
      where r.tenant_id=${input.tenantId}::uuid and r.session_id=${input.sessionId}
        and r.kind='entry' and r.fields->>'conversation'=${String(conversationId)} and r.id<=${pageThrough}
        ${input.from === undefined ? sql`` : sql`and r.id>=${input.from}`}
        ${input.navigationOnly ? sql`and (r.fields->>'navigation' in ('user','assistant') ${input.includeEntryIds?.length ? sql`or r.id=any(${[...input.includeEntryIds]}::bigint[])` : sql``})` : sql``}
        ${head === undefined ? sql`` : sql`and r.id>=${head}`}
      order by r.id desc limit ${count}`.execute(database);
      for (const row of page.rows) {
        const write = JSON.parse(row.body) as { type: "entry"; value: ImagePacked<EntryRecord> };
        const entry = write.value;
        if (input.activeOnly && head === undefined && entry.head !== undefined) head = entry.head;
        if (head !== undefined && entry.id < head) break;
        rows.push(historyEntry(row));
      }
      if (page.rows.length < count) break;
      pageThrough = historyEntry(page.rows.at(-1)!).entry.id - 1;
      if (head !== undefined && pageThrough < head) break;
    }
    if (
      !conversation.parent ||
      (head !== undefined && conversation.parent.at < head) ||
      (input.from !== undefined && conversation.parent.at < input.from)
    )
      break;
    through = Math.min(through, conversation.parent.at);
    conversationId = conversation.parent.conversationId;
  }
  return rows;
}

/** Full immutable prefix for an administrative copy, in bounded ascending pages.
 * Navigation filtering never controls which context bytes the Fork preserves. */
export async function* iterateDurableHistoryPrefix(
  database: Kysely<Database>,
  input: DurableScope & { conversationId: number; through: number },
): AsyncGenerator<StoredHistoryEntry> {
  const projection = new DurablePostgresProjection(database, input, undefined, "references");
  const ranges: { conversationId: number; through: number }[] = [],
    seen = new Set<number>();
  let conversationId = input.conversationId,
    through = input.through;
  for (;;) {
    if (seen.has(conversationId)) throw new Error("Native conversation ancestry contains a cycle");
    seen.add(conversationId);
    const row = await projection.get(conversationId);
    if (row?.kind !== "conversation") throw new Error("Fork source conversation is missing");
    ranges.push({ conversationId, through });
    const parent = (row.value as ConversationRecord).parent;
    if (!parent) break;
    through = Math.min(through, parent.at);
    conversationId = parent.conversationId;
  }
  for (const range of ranges.reverse()) {
    let after = 0;
    for (;;) {
      const { rows } = await sql<HistoryRow>`select l.body,r.fields,r.seq,c.committed_at
        from pi_durable_records r join pi_durable_log l using(tenant_id,session_id,seq,ordinal)
        join pi_durable_commits c using(tenant_id,session_id,seq)
        where r.tenant_id=${input.tenantId}::uuid and r.session_id=${input.sessionId}
          and r.kind='entry' and r.fields->>'conversation'=${String(range.conversationId)}
          and r.id>${after} and r.id<=${range.through} order by r.id limit 64`.execute(database);
      for (const row of rows) yield historyEntry(row);
      if (rows.length < 64) break;
      after = historyEntry(rows.at(-1)!).entry.id;
    }
  }
}

/** Administrative branch switch, admitted only while the physical family has
 * no writer. Generic Session performs native document fork semantics; there is
 * no Harness, scheduler, model provider or Tool environment in the API. */
export async function forkIdleConversation(
  tx: Transaction<Database>,
  scope: DurableScope,
  conversationId: number,
  at: number,
): Promise<number> {
  await assertIdleNativeSession(tx, scope.tenantId, scope.sessionId);
  const projection = new DurablePostgresProjection(tx, scope, undefined, "references");
  const storage = await PublishedDurableStorage.open({
    projection,
    publish: async (batch) => {
      await projection.applyIn(tx, batch as StoredDurableBatch);
    },
    waitProjected: async () => {},
  });
  const session = createSession(storage);
  try {
    return await session.commit(
      async (change) =>
        (
          await change.forkConversation(conversationId as ConversationId, at as EntryId, {
            ownership: { kind: "ownerless" },
          })
        ).id,
      BACKGROUND_CONTEXT,
    );
  } finally {
    await session.close(BACKGROUND_CONTEXT);
  }
}

/** Independent human fork. Copy immutable context records into a new physical
 * Session so deleting the source never invalidates the fork's history or images.
 * No live tasks, queued submissions, provider credentials or ownership edges copy. */
export async function copyDurableHistory(
  tx: Transaction<Database>,
  scope: DurableScope,
  entries: Iterable<StoredHistoryEntry> | AsyncIterable<StoredHistoryEntry>,
  source?: DurableScope & { conversationId: number },
): Promise<void> {
  await assertIdleNativeSession(tx, scope.tenantId, scope.sessionId);
  let writes: StorageWrite[] = [{ type: "conversation", value: { id: 1 as ConversationId } }];
  let origins: DurableRecordOrigin[] = [];
  let nextId = 2,
    seq = 0,
    bytes = 0,
    cutoff: StoredHistoryEntry | undefined;
  const flush = async () => {
    if (!writes.length) return;
    await new DurablePostgresProjection(tx, scope).applyIn(
      tx,
      { seq: ++seq as Seq, nextId, writes } as StoredDurableBatch,
      origins,
    );
    writes = [];
    origins = [];
    bytes = 0;
  };
  for await (const row of entries) {
    cutoff = row;
    const { byTaskId: _task, ...entry } = row.entry;
    nextId = Math.max(nextId, entry.id + 1);
    writes.push({
      type: "entry",
      value: { ...entry, conversationId: 1 as ConversationId },
    } as StorageWrite);
    if (row.turnId && row.runId && row.sessionId)
      origins.push({
        recordId: entry.id,
        turnId: row.turnId,
        runId: row.runId,
        sessionId: row.sessionId,
      });
    bytes += Buffer.byteLength(JSON.stringify(writes.at(-1)));
    if (writes.length >= 32 || bytes >= 512 * 1024) await flush();
  }
  if (source && cutoff) {
    // Native fork policy: asOf documents follow the actual cutoff entry's
    // conversation/commit; current documents follow the selected conversation.
    // Session/task documents and fork:initial state never transfer ownership.
    const view = await PublishedDurableStorage.open({
      projection: new DurablePostgresProjection(tx, source, undefined, "references"),
      publish: async () => {
        throw new Error("Fork source is read-only");
      },
      waitProjected: async () => {},
    });
    try {
      const selections: { conversationId: number; at: DocumentPoint; fork: "asOf" | "current" }[] =
        [
          { conversationId: cutoff.entry.conversationId, at: cutoff.seq as Seq, fork: "asOf" },
          { conversationId: source.conversationId, at: "current", fork: "current" },
        ];
      const addresses = new Set<string>();
      for (const selection of selections) {
        let cursor: Cursor | undefined;
        do {
          const page = await view.scanDocuments(
            {
              scope: {
                kind: "conversation",
                conversationId: selection.conversationId as ConversationId,
              },
              at: selection.at,
            },
            256,
            cursor,
            BACKGROUND_CONTEXT,
          );
          for (const record of page.items) {
            if (record.scope.kind !== "conversation" || record.fork !== selection.fork) continue;
            const address = JSON.stringify([record.kind, record.key ?? null]);
            if (addresses.has(address))
              throw new Error("Fork selects duplicate document addresses");
            addresses.add(address);
            const content = await view.document(record.id, selection.at, BACKGROUND_CONTEXT);
            if (!content) throw new Error("Fork source document is missing");
            const { createdAt: _created, retiredAt: _retired, ...definition } = record;
            writes.push({
              type: "document.create",
              record: {
                ...definition,
                id: nextId++ as DocumentId,
                scope: { kind: "conversation", conversationId: 1 as ConversationId },
              },
              content: { kind: "base", version: content.version, value: content.value },
            });
            bytes += Buffer.byteLength(JSON.stringify(writes.at(-1)));
            if (writes.length >= 32 || bytes >= 512 * 1024) await flush();
          }
          cursor = page.next;
        } while (cursor !== undefined);
      }
    } finally {
      await view.close(BACKGROUND_CONTEXT);
    }
  }
  await flush();
}
