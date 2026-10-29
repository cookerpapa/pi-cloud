import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "@pi-cloud/database";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  createSession,
  type ConversationId,
  type EntryId,
  type EntryRecord,
} from "@earendil-works/pi-durable";
import type { ImagePacked } from "@pi-cloud/protocol";
import { assertIdleNativeSession } from "../idle-session-mutation.ts";
import { PublishedDurableStorage } from "./published-storage.ts";
import { DurablePostgresProjection } from "./postgres-projection.ts";
import type { DurableScope, StoredDurableBatch } from "./types.ts";
import { nativeBodyAtRecord } from "./record-body.ts";

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
  const path = await projection.conversationPath(
    input.conversationId,
    input.through ?? Number.MAX_SAFE_INTEGER,
    true,
  );
  const rows: StoredHistoryEntry[] = [];
  if (!path.length) return rows;
  const scopes = sql`(values ${sql.join(path.map((r, i) => sql`(${r.record.value.id}::bigint,${r.through}::bigint,${i}::int)`))})`;
  let pageThrough = input.through ?? Number.MAX_SAFE_INTEGER,
    head: number | undefined;
  while (rows.length < input.limit) {
    const count = Math.min(64, input.limit - rows.length);
    const page = await sql<HistoryRow>`select l.body,r.fields,r.seq,l.committed_at from (
      select r.*,s.position from ${scopes} s(conversation_id,through_id,position) join pi_durable_records r
        on r.tenant_id=${input.tenantId}::uuid and r.session_id=${input.sessionId} and r.kind='entry'
        and r.fields->>'conversation'=s.conversation_id::text and r.id<=least(s.through_id,${pageThrough}) and r.id>=${Math.max(input.from ?? 0, head ?? 0)}
        ${input.navigationOnly ? sql`and (r.fields->>'navigation' in ('user','assistant') ${input.includeEntryIds?.length ? sql`or r.id=any(${[...input.includeEntryIds]}::bigint[])` : sql``})` : sql``}
      order by s.position,r.id desc limit ${count}
    ) r ${nativeBodyAtRecord} order by r.position,r.id desc`.execute(database);
    for (const row of page.rows) {
      const entry = historyEntry(row);
      if (input.activeOnly && head === undefined && entry.entry.head !== undefined)
        head = entry.entry.head;
      if (head !== undefined && entry.entry.id < head) break;
      rows.push(entry);
    }
    if (page.rows.length < count) break;
    pageThrough = historyEntry(page.rows.at(-1)!).entry.id - 1;
    if (head !== undefined && pageThrough < head) break;
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
