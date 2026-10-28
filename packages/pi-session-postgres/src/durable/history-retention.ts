import { sql, type Transaction } from "kysely";
import type { Database } from "@pi-cloud/database";
import type { ConversationRecord, Seq, StorageWrite, TaskRecord } from "@earendil-works/pi-durable";
import type { DurableRecordOrigin } from "@pi-cloud/protocol";
import { assertIdleNativeSession } from "../idle-session-mutation.ts";
import { DurablePostgresProjection } from "./postgres-projection.ts";
import type { DurableScope, StoredDurableBatch } from "./types.ts";

type Range = { id: number; through: number; sequence: number; leaf: boolean };
type Row = {
  record_id: string;
  seq: string;
  ordinal: number;
  body: string;
  cloud_origin: Record<string, string> | null;
};

/** Rebuild a closed physical family, keeping native identities but allocating a fresh commit sequence.
 * The caller freezes presentation, switches ALL product bindings and retires the old store in this transaction. */
export async function retainIdleFamily(
  tx: Transaction<Database>,
  source: DurableScope,
  target: DurableScope,
  conversations: readonly number[],
  retainedSources: readonly {
    sequence: number;
    recordId: number;
    kind: string;
    requestId?: string;
  }[] = [],
): Promise<Map<string, number>> {
  if (
    source.tenantId !== target.tenantId ||
    source.sessionId === target.sessionId ||
    !conversations.length
  )
    throw new Error("Invalid cold history replacement");
  await assertIdleNativeSession(tx, source.tenantId, source.sessionId);
  await assertIdleNativeSession(tx, target.tenantId, target.sessionId);
  const original = new DurablePostgresProjection(tx, source, undefined, "references");
  const destination = new DurablePostgresProjection(tx, target, undefined, "references");
  const head = await original.head(true);
  if ((await destination.head()).seq) throw new Error("Cold history target is not empty");
  const active =
    await sql`select 1 from pi_durable_records where tenant_id=${source.tenantId}::uuid and session_id=${source.sessionId}
    and kind='task' and fields->>'status'<>'terminal' limit 1`.execute(tx);
  if (active.rows.length) throw new Error("Cold history still has live native tasks");
  const ranges = new Map<number, Range>(),
    owners = new Set<number>(
      retainedSources.filter((r) => r.kind === "task").map((r) => r.recordId),
    );
  for (const leaf of conversations) {
    let id = leaf,
      through = Number.MAX_SAFE_INTEGER;
    const visited = new Set<number>();
    for (;;) {
      if (visited.has(id)) throw new Error("Cold history Conversation ancestry cycle");
      visited.add(id);
      const record = await original.get(id);
      if (record?.kind !== "conversation") throw new Error("Retained Conversation is missing");
      const value = record.value as ConversationRecord;
      const sequence =
        through === Number.MAX_SAFE_INTEGER ? head.seq : await original.recordSequence(through);
      if (sequence === undefined) throw new Error("Retained Conversation boundary is missing");
      const old = ranges.get(id);
      ranges.set(id, {
        id,
        through: Math.max(old?.through ?? 0, through),
        sequence: Math.max(old?.sequence ?? 0, sequence),
        leaf: old?.leaf === true || id === leaf,
      });
      if (value.owner) owners.add(value.owner.taskId);
      if (!value.parent) break;
      through = Math.min(through, value.parent.at);
      id = value.parent.conversationId;
    }
  }
  // Native ownership is independent of context inheritance (an empty-context child still has an owner).

  for (const id of owners) {
    const record = await original.get(id);
    if (record?.kind !== "task") throw new Error("Retained Conversation owner is missing");
    const value = record.value as TaskRecord<never, never, never>;
    if (value.state.status !== "terminal")
      throw new Error("Retained Conversation owner is still live");
    if (value.owner) owners.add(value.owner);
    if (!ranges.has(value.conversationId))
      throw new Error("Retained owner Conversation is outside this family");
  }
  const ids = [...new Set([1, ...ranges.keys()])],
    scopeKeys = [...ranges.keys()].map((id) => JSON.stringify(["conversation", id]));
  const docs = (
    await sql<{
      id: string;
      scope: string;
      policy: string;
      current: boolean;
      created: string;
      nativeKind: string;
      key: string | null;
    }>`select id::text,fields->>'scope' as scope,
    fields->>'nativeKind' as "nativeKind",fields->>'key' as key,fields->>'forkPolicy' as policy,exists(select 1 from pi_durable_current c where c.tenant_id=r.tenant_id and c.session_id=r.session_id and c.id=r.id) as current,created_seq::text as created
    from pi_durable_records r where tenant_id=${source.tenantId}::uuid and session_id=${source.sessionId} and kind='document'
      and (fields->>'scope'=any(${scopeKeys}::text[]) or fields->>'scope'='["session"]'
        or fields->>'scope'=any(${[...owners].map((id) => JSON.stringify(["task", id]))}::text[]))`.execute(
      tx,
    )
  ).rows;
  const selectedDocs = docs.flatMap((d) => {
    const scope = JSON.parse(d.scope) as [string, number?],
      range = scope[0] === "conversation" ? ranges.get(scope[1]!) : undefined;
    if (
      scope[0] === "session" &&
      ['"pi-cloud.conversation-creation"', '"pi-cloud.conversation-stop"'].includes(d.nativeKind) &&
      !retainedSources.some((r) => r.requestId && JSON.stringify(r.requestId) === d.key)
    )
      return [];
    // Ancestral initial state is intentionally reset by the native Fork; leaf state retains current values.
    if (range && !range.leaf && d.policy === "initial") return [];
    const sequence = !range || range.leaf ? head.seq : range.sequence;
    return Number(d.created) <= sequence ? [{ ...d, sequence }] : [];
  });
  const currentIds = selectedDocs.filter((d) => d.current).map((d) => d.id);
  const selected = sql`((l.record_kind='task' and l.record_id=any(${[...owners]}::bigint[]))
    or (l.record_kind='conversation' and l.record_id=any(${ids}::bigint[]))
    or (l.record_kind='entry' and exists(select 1 from pi_durable_records r
      join unnest(${[...ranges.keys()]}::bigint[],${[...ranges.values()].map((r) => r.through)}::bigint[]) p(id,through_id)
        on r.fields->>'conversation'=p.id::text and r.id<=p.through_id
      where r.tenant_id=l.tenant_id and r.session_id=l.session_id and r.id=l.record_id and r.kind='entry'))
    or (l.record_kind in ('document.create','document.change','document.retire') and exists(
      select 1 from unnest(${selectedDocs.filter((d) => !d.current).map((d) => d.id)}::bigint[],${selectedDocs.filter((d) => !d.current).map((d) => d.sequence)}::bigint[]) d(id,through_seq)
      where l.record_id=d.id and l.seq<=d.through_seq)))`;
  let seq = 0;
  const positions = new Map<string, number>();
  const publish = async (rows: readonly Row[]) => {
    if (!rows.length) return;
    const origins: DurableRecordOrigin[] = [];
    const writes = rows.map((row) => {
      if (
        retainedSources.some(
          (r) => r.sequence === Number(row.seq) && r.recordId === Number(row.record_id),
        )
      )
        positions.set(`${row.seq}:${row.record_id}`, seq + 1);
      let write = JSON.parse(row.body) as StorageWrite;
      if (
        write.type === "entry" &&
        write.value.byTaskId !== undefined &&
        !owners.has(write.value.byTaskId)
      ) {
        const { byTaskId: _task, ...value } = write.value;
        write = { type: "entry", value };
      }
      const origin = row.cloud_origin;
      if (origin?.cloudSession && origin.run && origin.turn)
        origins.push({
          recordId: Number(row.record_id),
          sessionId: origin.cloudSession,
          runId: origin.run,
          turnId: origin.turn,
        });
      return write;
    });
    await destination.applyIn(
      tx,
      { seq: ++seq as Seq, nextId: head.nextId, writes } as StoredDurableBatch,
      origins,
    );
  };
  let after = 0;
  for (;;) {
    const commits = (
      await sql<{ seq: string }>`select distinct l.seq from pi_durable_log l
      where l.tenant_id=${source.tenantId}::uuid and l.session_id=${source.sessionId} and l.seq>${after} and ${selected}
      order by l.seq limit 64`.execute(tx)
    ).rows;
    if (!commits.length) break;
    for (const commit of commits) {
      const state = (
        await sql<Row>`select l.record_id::text,l.seq::text,l.ordinal,l.body,l.cloud_origin from pi_durable_log l
        where l.tenant_id=${source.tenantId}::uuid and l.session_id=${source.sessionId} and l.seq=${commit.seq}::bigint
          and l.record_kind<>'entry' and ${selected} order by l.ordinal`.execute(tx)
      ).rows;
      await publish(state);
      let ordinal = -1;
      for (;;) {
        const rows = (
          await sql<Row>`select l.record_id::text,l.seq::text,l.ordinal,l.body,l.cloud_origin from pi_durable_log l
          where l.tenant_id=${source.tenantId}::uuid and l.session_id=${source.sessionId} and l.seq=${commit.seq}::bigint
            and l.ordinal>${ordinal} and l.record_kind='entry' and ${selected} order by l.ordinal limit 32`.execute(
            tx,
          )
        ).rows;
        if (!rows.length) break;
        await publish(rows);
        ordinal = rows.at(-1)!.ordinal;
      }
      after = Number(commit.seq);
    }
  }
  // Current Inbox/input/Submission values remain current; no abandoned intermediate versions are recreated.
  let afterId = 0;
  for (;;) {
    const rows = (
      await sql<Row>`select c.id::text as record_id,c.seq::text,c.ordinal,c.body,c.cloud_origin
      from pi_durable_current c join pi_durable_records r on r.tenant_id=c.tenant_id and r.session_id=c.session_id and r.id=c.id
      where c.tenant_id=${source.tenantId}::uuid and c.session_id=${source.sessionId} and c.id>${afterId}
        and ((c.kind='document' and c.id=any(${currentIds}::bigint[]) and c.retired_seq is null)
          or (c.kind='submission' and r.fields->>'conversation'=any(${conversations.map(String)}::text[])))
      order by c.id limit 32`.execute(tx)
    ).rows;
    if (!rows.length) break;
    for (const row of rows) {
      const write = JSON.parse(row.body);
      if (
        write.type === "document.create" &&
        write.record.kind === "pi.inbox" &&
        write.content.value.items?.length
      )
        throw new Error("Cold history still has pending Inbox inputs");
    }
    await publish(rows);
    afterId = Number(rows.at(-1)!.record_id);
  }
  for (const source of retainedSources)
    if (!positions.has(`${source.sequence}:${source.recordId}`))
      throw new Error("Retained child creation source is missing");
  await destination.rebuildIn(tx);
  return positions;
}
