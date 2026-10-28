import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "@pi-cloud/database";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createSession,
  type ConversationId,
  type EntryId,
  type EntryRecord,
  type ConversationRecord,
} from "@earendil-works/pi-durable";
import type { ImagePacked } from "@pi-cloud/protocol";
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
