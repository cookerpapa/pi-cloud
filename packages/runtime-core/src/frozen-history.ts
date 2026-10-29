import { settleHistoryTurn } from "./presentation-settlement.ts";
import { HistoryDirectory } from "@pi-cloud/pi-session-postgres/durable";
import { PostgresPresentationDirectory } from "./presentation-directory.ts";
import { retainedImageReferences } from "@pi-cloud/session-attachments";
import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "@pi-cloud/database";
import { readHumanInputPresentation } from "@pi-cloud/pi-session-postgres/durable";
import type { UserUpload } from "@pi-cloud/protocol";

export type FrozenRecord = {
  fields: Record<string, string>;
  committedAt: string;
  taskKind: string | null;
  body?: string;
  human?: { inputId: string; text: string; uploads: UserUpload[] };
};
export type HistoryHeader = {
  input_text: string | null;
  input_source: string | null;
  input_uploads: unknown[];
  scheduled_origin: unknown;
  output_display_seq: string;
  terminal?: { seq: string; type: string; payload: Record<string, unknown>; occurred_at: string };
};
export type HistoryTurnRow = {
  tenant_id: string;
  session_id: string;
  origin_session_id: string;
  turn_id: string;
  run_id: string;
  pi_session_id: string;
  mailbox_position: string;
  operation_kind: "chat" | "compact";
  state: string;
  stop_reason: string | null;
  output_display_seq: string;
  output_display_native_seq: string;
  waiting_for_seal: boolean;
  created_at: Date;
  frozen: boolean;
};

/** Capture display-only descriptors in the source commit, while its native Task
 * and input metadata are still available. Forks share these retained objects. */
export async function captureNativePresentation(
  tx: Transaction<Database>,
  scope: { tenantId: string; sessionId: string },
  sequence: number,
  onlyTurnId?: string,
): Promise<void> {
  const { rows } = await sql<{
    retained_id: string;
    ordinal: number;
    turn_id: string;
    source_session_id: string;
    assistant_record_id: string | null;
    id: string;
    body: string | null;
    kind: string;
    fields: Record<string, string>;
    committed_at: Date;
    body_bytes: number;
    task_kind: string | null;
    assistant_id: string | null;
  }>`select g.id as retained_id,ref.ordinal,g.cloud_origin->>'turn' as turn_id,g.cloud_origin->>'cloudSession' as source_session_id,
      assistant.retained_record_id as assistant_record_id,g.record_id::text as id,g.body,g.record_kind as kind,r.fields,g.committed_at,
      case when g.record_kind='entry' then b.payload_bytes+octet_length(pi_native_entry_prefix(g.record_id,g.entry_conversation_id,g.entry_task_id)) else octet_length(g.body) end::int as body_bytes,
      task.fields->>'nativeKind' as task_kind,coalesce(r.fields->>'assistant',task.fields->>'assistant',a.id::text) as assistant_id
    from pi_durable_write_refs ref join pi_history_records g on g.tenant_id=ref.tenant_id and g.id=ref.retained_record_id
    join pi_durable_owned_records r on r.tenant_id=ref.tenant_id and r.session_id=ref.session_id and r.id=g.record_id
    join sessions s on s.tenant_id=g.tenant_id and s.id=(g.cloud_origin->>'cloudSession')::uuid
    left join pi_history_bodies b on b.tenant_id=g.tenant_id and b.id=g.entry_body_id
    left join pi_durable_owned_records task on task.tenant_id=r.tenant_id and task.session_id=r.session_id and task.id=(r.fields->>'task')::bigint and task.kind='task'
    left join lateral(select p.id from pi_durable_records p where p.tenant_id=r.tenant_id and p.session_id=r.session_id
      and r.fields->>'role'='toolResult' and coalesce(r.fields->>'assistant',task.fields->>'assistant') is null
      and p.kind='entry' and p.fields->>'conversation'=r.fields->>'conversation' and p.fields->>'role'='assistant' and p.id<r.id order by p.id desc limit 1) a on true
    left join pi_durable_records assistant on assistant.tenant_id=r.tenant_id and assistant.session_id=r.session_id
      and assistant.id=coalesce(r.fields->>'assistant',task.fields->>'assistant',a.id::text)::bigint and assistant.kind='entry'
    where ref.tenant_id=${scope.tenantId}::uuid and ref.session_id=${scope.sessionId} and ref.seq=${sequence} and not ref.base
      ${onlyTurnId ? sql`and g.cloud_origin->>'turn'=${onlyTurnId}` : sql``}
      and not exists(select 1 from pi_history_blocks block join pi_history_frames frame on frame.tenant_id=block.tenant_id and frame.block_id=block.id
        where block.tenant_id=ref.tenant_id and block.source_pi_session_id=ref.session_id and block.turn_id=(g.cloud_origin->>'turn')::uuid and (frame.seq,frame.ordinal)=(ref.seq,ref.ordinal))
      and (g.record_kind='entry' or (g.record_kind='task' and (g.phase='"retry"'
        or ((g.seq,g.ordinal)=(r.seq,r.ordinal) and r.fields->>'nativeKind' in ('"pi.tool"','"pi.compaction"') and r.fields->>'status'='terminal'
          and not(r.fields ? 'resultEntry') and not exists(select 1 from pi_durable_records result
            where result.tenant_id=r.tenant_id and result.session_id=r.session_id and result.kind='entry' and result.fields->>'task'=r.id::text)))))
    order by ref.ordinal`.execute(tx);
  if (!rows.length) return;
  const users = rows.filter((r) => r.fields.role === "user");
  const submissions = users.length
    ? (
        await sql<{
          id: string;
          fields: Record<string, string>;
        }>`select id::text,fields from pi_durable_records
    where tenant_id=${scope.tenantId}::uuid and session_id=${scope.sessionId} and kind='submission' and fields->>'entry'=any(${users.map((r) => r.id)}::text[])`.execute(
          tx,
        )
      ).rows
    : [];
  const requests = submissions.flatMap((r) => {
    const inputId = r.fields.request ? JSON.parse(r.fields.request) : null;
    const entry = users.find((e) => e.id === r.fields.entry)!;
    return typeof inputId === "string" && inputId.startsWith("input-") && r.fields.run
      ? [
          {
            inputId,
            nativeId: r.id,
            runId: r.fields.run,
            conversationId: Number(r.fields.conversation),
            entryBytes: entry.body_bytes,
            entryId: entry.id,
          },
        ]
      : [];
  });
  const humans = await readHumanInputPresentation(tx, scope, requests);
  const sources = [...new Map(rows.map((row) => [row.turn_id, row])).values()];
  const blocks = (
    await sql<{ id: string; turn_id: string }>`with affected(session_id,turn_id) as (
    values ${sql.join(sources.map((row) => sql`(${row.source_session_id}::uuid,${row.turn_id}::uuid)`))}
  ), inserted as (
    insert into pi_history_blocks(tenant_id,source_session_id,source_pi_session_id,owner_pi_session_id,turn_id,origin_session_id,position)
    select ${scope.tenantId}::uuid,a.session_id,${scope.sessionId},${scope.sessionId},a.turn_id,a.session_id,t.mailbox_position
      from affected a join conversation_turns t on t.tenant_id=${scope.tenantId}::uuid and t.session_id=a.session_id and t.turn_id=a.turn_id where t.pruned_at is null
    on conflict(tenant_id,source_pi_session_id,turn_id) do nothing returning id,turn_id
  ) select * from inserted union all select b.id,b.turn_id from pi_history_blocks b join affected a on a.turn_id=b.turn_id and a.session_id=b.source_session_id
    where b.tenant_id=${scope.tenantId}::uuid and b.source_pi_session_id=${scope.sessionId}`.execute(
      tx,
    )
  ).rows;
  const blockIds = new Map(blocks.map((block) => [block.turn_id, block.id]));
  if (blockIds.size !== sources.length) throw new Error("Native presentation has no admitted Turn");
  for (let start = 0; start < rows.length; start += 128) {
    const objects = new Map<string, { id: string; text: string }>();
    const images: { record: string; image: string }[] = [];
    const refs = rows.slice(start, start + 128).map((row) => {
      const request = requests.find((r) => r.entryId === row.id),
        human = request ? humans.get(request.inputId) : undefined;
      const descriptor: FrozenRecord = {
        fields: row.fields.task ? { task: row.fields.task } : {},
        committedAt: new Date(row.committed_at).toISOString(),
        taskKind: row.task_kind,
        ...(row.kind === "entry" ? {} : { body: row.body! }),
        ...(human && request
          ? {
              human: {
                inputId: request.inputId,
                text: human.text,
                uploads: human.uploads as UserUpload[],
              },
            }
          : {}),
      };
      const text = JSON.stringify(descriptor),
        hash = createHash("sha256").update(text).digest("hex");
      if (!objects.has(hash)) objects.set(hash, { id: randomUUID(), text });
      for (const upload of descriptor.human?.uploads ?? [])
        if (upload.image)
          for (const ref of retainedImageReferences({
            type: "pi_cloud_image_v1",
            attachment: upload.image,
          }))
            images.push({ record: row.retained_id, image: ref.id });
      return {
        row,
        hash,
        bytes: Buffer.byteLength(text) + (row.kind === "entry" ? row.body_bytes : 0),
      };
    });
    await sql`with bodies as (
      insert into pi_history_bodies(tenant_id,body_kind,id,sha256,payload_text,payload_bytes) values
        ${sql.join([...objects].sort(([a], [b]) => a.localeCompare(b)).map(([hash, value]) => sql`(${scope.tenantId}::uuid,'metadata',${value.id}::uuid,${hash},${value.text},${Buffer.byteLength(value.text)})`))}
      on conflict(tenant_id,body_kind,sha256) do update set sha256=excluded.sha256 where pi_history_bodies.payload_text=excluded.payload_text returning id,sha256
    ), links(block_id,ordinal,record_id,entry_id,entry_record_id,assistant_id,assistant_record_id,hash,bytes,fields) as (
      values ${sql.join(
        refs.map(
          (
            v,
          ) => sql`(${blockIds.get(v.row.turn_id)}::uuid,${v.row.ordinal}::int,${v.row.id}::bigint,
        ${v.row.kind === "entry" ? v.row.id : null}::bigint,${v.row.kind === "entry" ? v.row.retained_id : null}::uuid,
        ${v.row.assistant_id}::bigint,${v.row.assistant_record_id}::uuid,${v.hash},${v.bytes}::bigint,
        ${JSON.stringify(v.row.fields.task ? { task: v.row.fields.task } : {})}::jsonb)`,
        ),
      )}
    ) insert into pi_history_frames(tenant_id,block_id,seq,ordinal,record_id,entry_id,entry_record_id,assistant_id,assistant_record_id,body_id,body_bytes,fields)
      select ${scope.tenantId}::uuid,l.block_id,${sequence},l.ordinal,l.record_id,l.entry_id,l.entry_record_id,l.assistant_id,l.assistant_record_id,b.id,l.bytes,l.fields
      from links l left join bodies b on b.sha256=l.hash on conflict do nothing`.execute(tx);
    if (images.length)
      await sql`insert into pi_history_record_images(tenant_id,retained_record_id,image_id)
      values ${sql.join(images.map((v) => sql`(${scope.tenantId}::uuid,${v.record}::uuid,${v.image}::uuid)`))} on conflict do nothing`.execute(
        tx,
      );
  }
}
export async function historyHeaders(
  db: Kysely<Database>,
  tenant: string,
  owner: string,
  ids: readonly string[],
) {
  const result = new Map<string, HistoryHeader>();
  if (!ids.length) return result;
  const rows = await sql<{
    turn_id: string;
    payload_text: string;
  }>`select r.turn_id,jsonb_build_object(
    'input_text',r.input_text,'input_source',r.input_source,'input_uploads',r.input_uploads,'scheduled_origin',r.scheduled_origin,
    'output_display_seq',r.output_display_seq::text,'terminal',case when e.turn_id is not null then
      jsonb_build_object('seq',e.seq::text,'type',e.type,'payload',e.payload,'occurred_at',e.occurred_at) end)::text as payload_text
    from conversation_turns r left join lateral(select * from session_terminal_events e where e.tenant_id=r.tenant_id and e.turn_id=r.turn_id order by e.seq desc limit 1) e on true
    where r.tenant_id=${tenant}::uuid and r.session_id=${owner}::uuid and r.turn_id=any(${[...ids]}::uuid[])
      and r.pruned_at is null and exists(select 1 from pi_history_live_turns live
        where live.tenant_id=r.tenant_id and live.session_id=r.session_id and live.turn_id=r.turn_id)
    union all select h.turn_id,b.payload_text from pi_history_snapshots h join pi_history_bodies b on b.tenant_id=h.tenant_id and b.id=h.body_id
    where h.tenant_id=${tenant}::uuid and h.session_id=${owner}::uuid and h.turn_id=any(${[...ids]}::uuid[]) and h.kind='turn' and not exists(select 1 from pi_history_live_turns live where live.tenant_id=h.tenant_id and live.session_id=h.session_id and live.turn_id=h.turn_id)`.execute(
    db,
  );
  for (const row of rows.rows) result.set(row.turn_id, JSON.parse(row.payload_text));
  for (const [id, header] of result)
    result.set(id, {
      ...header,
      input_uploads: (header.input_uploads as UserUpload[]).map((u) => ({
        ...u,
        sessionId: owner,
      })),
    });
  return result;
}

export async function freezeForkHistory(
  tx: Transaction<Database>,
  input: {
    tenantId: string;
    sourceSessionId: string;
    targetSessionId: string;
    throughTurnId: string;
    throughEntryId?: string;
    settledOnly?: boolean;
  },
): Promise<number> {
  const { tenantId: tenant, sourceSessionId: source, targetSessionId: target } = input;
  let anchor = (
    await sql<HistoryTurnRow>`select * from pi_history_turns where tenant_id=${tenant}::uuid
    and session_id=${source}::uuid and turn_id=${input.throughTurnId}::uuid`.execute(tx)
  ).rows[0];
  if (!anchor || (!input.settledOnly && anchor.state !== "completed") || anchor.waiting_for_seal)
    throw new Error("Fork display boundary is not settled");
  if (!anchor.frozen) {
    // Capture an already-materialized prefix; this performs no history-body import.
    await settleHistoryTurn(tx, tenant, source, input.throughTurnId);
    anchor = (
      await sql<HistoryTurnRow>`select * from pi_history_turns where tenant_id=${tenant}::uuid and session_id=${source}::uuid and turn_id=${input.throughTurnId}::uuid`.execute(
        tx,
      )
    ).rows[0]!;
  }
  const owner = (
    await sql<{ root_id: string }>`select root_id from pi_history_views
    where tenant_id=${tenant}::uuid and session_id=${source}::uuid`.execute(tx)
  ).rows[0];
  if (!owner || !anchor.frozen)
    throw new Error("Completed history is awaiting its presentation checkpoint");
  const adapter = new PostgresPresentationDirectory(tx, tenant),
    directory = new HistoryDirectory(adapter);
  let root = await directory.prefix(
    await directory.read(owner.root_id),
    Number(anchor.mailbox_position),
  );
  if (input.throughEntryId) {
    const point = (
      await sql<{
        block_id: string;
        seq: string;
        ordinal: number;
      }>`select v.block_id,f.seq::text,f.ordinal
      from pi_history_visible_blocks v join pi_history_frames f on f.tenant_id=v.tenant_id and f.block_id=v.block_id
      where v.tenant_id=${tenant}::uuid and v.session_id=${source}::uuid and v.position=${anchor.mailbox_position}::bigint
        and f.entry_id=${input.throughEntryId}::bigint and (f.seq,f.ordinal)<=(v.through_seq,v.through_ordinal)`.execute(
        tx,
      )
    ).rows[0];
    if (!point) throw new Error("Fork presentation boundary is missing");
    root = await directory.mapRanges(root, async (range) =>
      range.blockId === point.block_id
        ? adapter.range(range.blockId, { seq: Number(point.seq), ordinal: point.ordinal }, range)
        : range,
    );
  }
  if (!root) throw new Error("Fork presentation prefix is empty");
  await directory.persist(root);
  await sql`insert into pi_history_views(tenant_id,session_id,root_id) values(${tenant}::uuid,${target}::uuid,${root.id}::uuid)
    on conflict(tenant_id,session_id) do update set root_id=excluded.root_id`.execute(tx);
  return Number(anchor.mailbox_position);
}
