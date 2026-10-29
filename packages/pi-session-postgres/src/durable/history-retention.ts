import { sql, type Transaction } from "kysely";
import type { Database } from "@pi-cloud/database";
import type { ConversationRecord, TaskRecord } from "@earendil-works/pi-durable";
import { assertIdleNativeSession } from "../idle-session-mutation.ts";
import { DurablePostgresProjection } from "./postgres-projection.ts";
import type { DurableScope } from "./types.ts";
import { currentStateFingerprint, type CurrentStateRow } from "./current-state.ts";
import { retainSessionImages } from "@pi-cloud/session-attachments";
import { HistoryDirectory } from "./history-directory.ts";
import { PostgresHistoryDirectory } from "./postgres-history-directory.ts";
import { readSharedBase, sharedStateFingerprint } from "./shared-history-base.ts";

type Range = { id: number; through: number; sequence: number; leaf: boolean };
/** Rebuild a closed physical family, sharing retained entries and preserving native commit positions.
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
    or (l.record_kind in ('document.create','document.change','document.retire') and exists(
      select 1 from unnest(${selectedDocs.filter((d) => !d.current).map((d) => d.id)}::bigint[],${selectedDocs.filter((d) => !d.current).map((d) => d.sequence)}::bigint[]) d(id,through_seq)
      where l.record_id=d.id and l.seq<=d.through_seq)))`;
  const adapter = new PostgresHistoryDirectory(tx, target.tenantId),
    directory = new HistoryDirectory(adapter);
  const existing = await readSharedBase(tx, source);
  if (existing?.entry_root) await adapter.prefetch(existing.entry_root);
  const retainedTasks = [...owners].sort((a, b) => a - b);
  const rootBefore = existing?.entry_root ? await directory.read(existing.entry_root) : undefined;
  let root = await directory.mapRanges(rootBefore, async (range) => {
    const bound = ranges.get(range.conversationId)?.through;
    if (bound === undefined) return undefined;
    const visible = range.maxId <= bound ? range : await adapter.clip(range, bound);
    if (!visible || visible.clearTask) return visible;
    const tasks = visible.retainedTasks?.filter((id) => owners.has(id)) ?? retainedTasks;
    return { ...visible, retainedTasks: tasks, clearTask: tasks.length === 0 };
  });
  for (const range of ranges.values()) {
    const own = await adapter.range({
      sourceId: source.sessionId,
      conversationId: range.id,
      throughSequence: head.seq,
      maximumId: range.through,
      clearTask: owners.size === 0,
      retainedTasks,
    });
    if (own) root = await directory.join(root, directory.range(own));
  }
  await directory.persist(root);
  await sql`insert into pi_durable_write_refs(tenant_id,session_id,seq,ordinal,retained_record_id,base,clear_owner)
    select ${target.tenantId}::uuid,${target.sessionId},l.seq,l.ordinal,l.retained_record_id,true,r.clear_owner
    from pi_durable_writes l join pi_durable_write_refs r using(tenant_id,session_id,seq,ordinal)
    where l.tenant_id=${source.tenantId}::uuid and l.session_id=${source.sessionId} and ${selected}`.execute(
    tx,
  );
  const hashes: Record<string, { seq: string; hash: string }> = {};
  let afterId = 0;
  for (;;) {
    const rows = (
      await sql<CurrentStateRow & { committed_at: Date; expected: string }>`select c.*,
      case when c.base_state then b.current_hashes->c.id::text->>'hash' else h.current_hashes->>c.id::text end as expected
      from pi_durable_current c join pi_durable_records r on r.tenant_id=c.tenant_id and r.session_id=c.session_id and r.id=c.id
      left join pi_durable_commits h on h.tenant_id=c.tenant_id and h.session_id=c.session_id and h.seq=c.seq
      left join pi_durable_bases b on b.tenant_id=c.tenant_id and b.session_id=c.session_id
      where c.tenant_id=${source.tenantId}::uuid and c.session_id=${source.sessionId} and c.id>${afterId}
        and ((c.kind='document' and c.id=any(${currentIds}::bigint[]) and c.retired_seq is null)
          or (c.kind='submission' and r.fields->>'conversation'=any(${conversations.map(String)}::text[])))
      order by c.id limit 64`.execute(tx)
    ).rows;
    if (!rows.length) break;
    for (const row of rows) {
      if (currentStateFingerprint(row) !== row.expected)
        throw new Error("Retained current state integrity check failed");
      const write = JSON.parse(row.body);
      if (
        write.type === "document.create" &&
        write.record.kind === "pi.inbox" &&
        write.content.value.items?.length
      )
        throw new Error("Cold history still has pending Inbox inputs");
      hashes[row.id] = { seq: String(row.seq), hash: row.expected };
    }
    await sql`insert into pi_durable_current(tenant_id,session_id,id,kind,seq,ordinal,body,delta_count,created_seq,retired_seq,cloud_origin,base_state,committed_at)
      values ${sql.join(rows.map((r) => sql`(${target.tenantId}::uuid,${target.sessionId},${r.id}::bigint,${r.kind},${r.seq}::bigint,${r.ordinal},${r.body},${r.delta_count},${r.created_seq}::bigint,${r.retired_seq}::bigint,${r.cloud_origin ? JSON.stringify(r.cloud_origin) : null}::jsonb,true,${r.committed_at})`))}`.execute(
      tx,
    );
    await retainSessionImages(
      tx,
      target,
      rows.map((r) => JSON.parse(r.body)),
    );
    afterId = Number(rows.at(-1)!.id);
  }
  const state = await sharedStateFingerprint(tx, target);
  await sql`insert into pi_durable_bases(tenant_id,session_id,through_seq,next_id,entry_root,entry_digest,history_count,history_fingerprint,current_hashes)
    values(${target.tenantId}::uuid,${target.sessionId},${head.seq},${head.nextId},${root?.id ?? null}::uuid,${root?.digest ?? null},${state.count}::bigint,${state.fingerprint},${JSON.stringify(hashes)}::jsonb)`.execute(
    tx,
  );
  await destination.initializeBaseIn(tx);
  const positions = new Map<string, number>();
  for (const source of retainedSources) {
    const found = (
      await sql`select 1 from pi_durable_writes l where l.tenant_id=${target.tenantId}::uuid and l.session_id=${target.sessionId}
      and l.seq=${source.sequence} and l.record_id=${source.recordId} and l.record_kind=${source.kind}`.execute(
        tx,
      )
    ).rows;
    if (!found.length) throw new Error("Retained child creation source is missing");
    positions.set(`${source.sequence}:${source.recordId}`, source.sequence);
  }
  return positions;
}
