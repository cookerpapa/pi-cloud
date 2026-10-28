import { retainSessionImages } from "@pi-cloud/session-attachments";
import { createHash, randomUUID } from "node:crypto";
import { sql, type Kysely, type Transaction } from "kysely";
import type { Database } from "@pi-cloud/database";
import { readHumanInputPresentation } from "@pi-cloud/pi-session-postgres/durable";
import type { UserUpload } from "@pi-cloud/protocol";
import type { NativeHistoryRow } from "./native-transcript-presentation.ts";

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

async function metadataObject(tx: Transaction<Database>, tenant: string, value: unknown) {
  const body = JSON.stringify(value),
    hash = createHash("sha256").update(body).digest("hex");
  const result = await sql<{ id: string }>`insert into pi_history_bodies
    (tenant_id,body_kind,id,sha256,payload_text,payload_bytes)
    values(${tenant}::uuid,'metadata',${randomUUID()}::uuid,${hash},${body},${Buffer.byteLength(body)})
    on conflict(tenant_id,body_kind,sha256) do update set sha256=excluded.sha256
      where pi_history_bodies.payload_text=excluded.payload_text returning id`.execute(tx);
  if (result.rows.length !== 1) throw new Error("Frozen history metadata digest conflict");
  return { id: result.rows[0]!.id, bytes: Buffer.byteLength(body) };
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
    from conversation_turns r left join session_terminal_events e on e.tenant_id=r.tenant_id and e.turn_id=r.turn_id
    where r.tenant_id=${tenant}::uuid and r.session_id=${owner}::uuid and r.turn_id=any(${[...ids]}::uuid[])
      and r.pruned_at is null and not exists(select 1 from pi_history_snapshots h
        where h.tenant_id=r.tenant_id and h.session_id=r.session_id and h.turn_id=r.turn_id and h.kind='turn')
    union all select h.turn_id,b.payload_text from pi_history_snapshots h join pi_history_bodies b on b.tenant_id=h.tenant_id and b.id=h.body_id
    where h.tenant_id=${tenant}::uuid and h.session_id=${owner}::uuid and h.turn_id=any(${[...ids]}::uuid[]) and h.kind='turn'`.execute(
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

export async function retainFrozenImages(
  tx: Transaction<Database>,
  scope: { tenantId: string; sessionId: string },
  owners: readonly string[],
): Promise<void> {
  let after:
    { session: string; turn: string; kind: string; seq: string; ordinal: number } | undefined;
  for (;;) {
    const rows = (
      await sql<{
        session_id: string;
        turn_id: string;
        kind: string;
        seq: string;
        ordinal: number;
        payload_text: string;
      }>`
      select h.session_id,h.turn_id,h.kind,h.seq::text,h.ordinal,b.payload_text from pi_history_snapshots h
      join pi_history_bodies b on b.tenant_id=h.tenant_id and b.id=h.body_id
      where h.tenant_id=${scope.tenantId}::uuid and h.session_id=any(${[...owners]}::uuid[])
        ${after ? sql`and (h.session_id,h.turn_id,h.kind,h.seq,h.ordinal)>(${after.session}::uuid,${after.turn}::uuid,${after.kind},${after.seq}::bigint,${after.ordinal})` : sql``}
      order by h.session_id,h.turn_id,h.kind,h.seq,h.ordinal limit 32`.execute(tx)
    ).rows;
    if (!rows.length) break;
    const images = rows.flatMap((row) => {
      const value = JSON.parse(row.payload_text),
        uploads = value.input_uploads ?? value.human?.uploads ?? [];
      return uploads.flatMap((u: { image?: unknown }) =>
        u.image ? [{ type: "pi_cloud_image_v1", attachment: u.image }] : [],
      );
    });
    await retainSessionImages(tx, scope, images);
    const last = rows.at(-1)!;
    after = {
      session: last.session_id,
      turn: last.turn_id,
      kind: last.kind,
      seq: last.seq,
      ordinal: last.ordinal,
    };
  }
}

/** Freeze display relationships only. Native Entries are already independently retained by the destination. */
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
  const anchor = (
    await sql<HistoryTurnRow>`select * from pi_history_turns where tenant_id=${tenant}::uuid
    and session_id=${source}::uuid and turn_id=${input.throughTurnId}::uuid`.execute(tx)
  ).rows[0];
  if (!anchor || (!input.settledOnly && anchor.state !== "completed") || anchor.waiting_for_seal)
    throw new Error("Fork display boundary is not settled");
  let after = 0;
  for (;;) {
    const turns =
      await sql<HistoryTurnRow>`select * from pi_history_turns where tenant_id=${tenant}::uuid
      and session_id=${source}::uuid and mailbox_position>${after} and mailbox_position<=${anchor.mailbox_position}::bigint
      order by mailbox_position limit 32`.execute(tx);
    if (!turns.rows.length) break;
    for (const turn of turns.rows) {
      if (
        turn.waiting_for_seal ||
        !["completed", "failed", "cancelled", "timed_out"].includes(turn.state)
      )
        throw new Error("Inherited history still has an unsettled Run");
      if (turn.frozen) {
        if (source === target) {
          if (turn.turn_id === input.throughTurnId && input.throughEntryId)
            await sql`delete from pi_history_snapshots
            where tenant_id=${tenant}::uuid and session_id=${source}::uuid and turn_id=${turn.turn_id}::uuid and kind='record'
              and (seq,ordinal)>(select seq,ordinal from pi_history_snapshots where tenant_id=${tenant}::uuid
                and session_id=${source}::uuid and turn_id=${turn.turn_id}::uuid and entry_id=${input.throughEntryId}::bigint)`.execute(
              tx,
            );
          continue;
        }
        // The source Session admission lock excludes pruning while these FK-backed references are installed.
        await sql`insert into pi_history_snapshots(tenant_id,session_id,turn_id,origin_session_id,kind,record_id,seq,ordinal,
          position,entry_id,assistant_id,body_id,fields,body_bytes)
          select tenant_id,${target}::uuid,turn_id,origin_session_id,kind,record_id,seq,ordinal,position,entry_id,assistant_id,body_id,fields,body_bytes
          from pi_history_snapshots where tenant_id=${tenant}::uuid and session_id=${source}::uuid and turn_id=${turn.turn_id}::uuid
            ${
              turn.turn_id === input.throughTurnId && input.throughEntryId
                ? sql`and (kind='turn' or (seq,ordinal)<=(select seq,ordinal from pi_history_snapshots
              where tenant_id=${tenant}::uuid and session_id=${source}::uuid and turn_id=${turn.turn_id}::uuid and entry_id=${input.throughEntryId}::bigint))`
                : sql``
            }`.execute(tx);
        continue;
      }
      const header = (await historyHeaders(tx, tenant, source, [turn.turn_id])).get(turn.turn_id);
      if (!header) throw new Error("History header is missing");
      const body = await metadataObject(tx, tenant, header);
      const fields = {
        runId: turn.run_id,
        operationKind: turn.operation_kind,
        runState: turn.state,
        stopReason: turn.stop_reason,
        coverage: turn.output_display_seq,
        nativeCoverage: turn.output_display_native_seq,
        acceptedAt: new Date(turn.created_at).toISOString(),
      };
      await sql`insert into pi_history_snapshots(tenant_id,session_id,turn_id,origin_session_id,kind,record_id,seq,ordinal,position,body_id,fields,body_bytes)
        values(${tenant}::uuid,${target}::uuid,${turn.turn_id}::uuid,${turn.origin_session_id}::uuid,'turn',0,0,0,
          ${turn.mailbox_position}::bigint,${body.id}::uuid,${JSON.stringify(fields)}::jsonb,${body.bytes})`.execute(
        tx,
      );
      const cutoff =
        turn.turn_id === input.throughTurnId && input.throughEntryId
          ? (
              await sql<{
                seq: string;
                ordinal: number;
              }>`select seq::text,ordinal from pi_durable_records
            where tenant_id=${tenant}::uuid and session_id=${turn.pi_session_id} and id=${input.throughEntryId}::bigint and kind='entry'`.execute(
                tx,
              )
            ).rows[0]
          : undefined;
      if (turn.turn_id === input.throughTurnId && input.throughEntryId && !cutoff)
        throw new Error("Fork native boundary is missing");
      let position = { seq: "0", ordinal: -1 };
      for (;;) {
        const { rows } = await sql<
          NativeHistoryRow & {
            ordinal: number;
            body_bytes: number;
            kind: string;
            assistant_id: string | null;
            task_kind: string | null;
            eligible: boolean;
          }
        >`with page as materialized (
          select w.* from pi_durable_writes w where w.tenant_id=${tenant}::uuid and w.session_id=${turn.pi_session_id}
            and w.cloud_origin->>'turn'=${turn.turn_id} and w.record_kind in ('entry','task')
            and (w.seq,w.ordinal)>(${position.seq}::bigint,${position.ordinal})
            ${cutoff ? sql`and (w.seq,w.ordinal)<=(${cutoff.seq}::bigint,${cutoff.ordinal})` : sql``}
          order by w.seq,w.ordinal limit 32
        ) select l.record_id::text as id,l.seq::text,l.ordinal,r.fields,l.record_kind as kind,l.body,
          case when l.record_kind='entry' then b.payload_bytes+octet_length(pi_native_entry_prefix(l.record_id,l.entry_conversation_id,l.entry_task_id))
            else octet_length(l.body) end::int as body_bytes,c.committed_at,
          task.fields->>'nativeKind' as task_kind,coalesce(r.fields->>'assistant',task.fields->>'assistant',a.id::text) as assistant_id,
          (l.record_kind='entry' or l.phase='"retry"' or ((l.seq,l.ordinal)=(r.seq,r.ordinal)
            and r.fields->>'nativeKind' in ('"pi.tool"','"pi.compaction"') and r.fields->>'status'='terminal'
            and not(r.fields ? 'resultEntry') and not exists(select 1 from pi_durable_records result
              where result.tenant_id=r.tenant_id and result.session_id=r.session_id and result.kind='entry' and result.fields->>'task'=r.id::text))) as eligible
        from page l join pi_durable_records r on r.tenant_id=l.tenant_id and r.session_id=l.session_id and r.id=l.record_id
        join pi_durable_commits c on c.tenant_id=l.tenant_id and c.session_id=l.session_id and c.seq=l.seq
        left join pi_history_bodies b on b.tenant_id=l.tenant_id and b.id=l.entry_body_id
        left join pi_durable_records task on task.tenant_id=r.tenant_id and task.session_id=r.session_id and task.id=(r.fields->>'task')::bigint and task.kind='task'
        left join lateral (select p.id from pi_durable_records p where p.tenant_id=r.tenant_id and p.session_id=r.session_id
          and r.fields->>'role'='toolResult' and coalesce(r.fields->>'assistant',task.fields->>'assistant') is null
          and p.kind='entry' and p.fields->>'conversation'=r.fields->>'conversation' and p.fields->>'role'='assistant' and p.id<r.id
          order by p.id desc limit 1) a on true
        order by l.seq,l.ordinal`.execute(tx);
        if (!rows.length) break;
        const userIds = rows.filter((r) => r.fields.role === "user").map((r) => r.id);
        const submissions = userIds.length
          ? (
              await sql<{
                id: string;
                fields: Record<string, string>;
              }>`select id::text,fields from pi_durable_records
          where tenant_id=${tenant}::uuid and session_id=${turn.pi_session_id} and kind='submission'
            and fields->>'entry'=any(${userIds}::text[])`.execute(tx)
            ).rows
          : [];
        const requests = submissions.flatMap((r) => {
          const inputId = r.fields.request ? JSON.parse(r.fields.request) : null;
          const entry = rows.find((e) => e.id === r.fields.entry)!;
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
        const humans = await readHumanInputPresentation(
          tx,
          { tenantId: tenant, sessionId: turn.pi_session_id },
          requests,
        );
        for (const row of rows.filter((r) => r.eligible)) {
          const request = requests.find((r) => r.entryId === row.id),
            human = request ? humans.get(request.inputId) : undefined;
          const descriptor: FrozenRecord = {
            fields: row.fields.task ? { task: row.fields.task } : {},
            committedAt: new Date(row.committed_at).toISOString(),
            taskKind: row.task_kind,
            ...(row.kind === "entry" ? {} : { body: row.body }),
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
          const stored = await metadataObject(tx, tenant, descriptor);
          await sql`insert into pi_history_snapshots(tenant_id,session_id,turn_id,origin_session_id,kind,record_id,seq,ordinal,
            position,entry_id,assistant_id,body_id,fields,body_bytes)
            values(${tenant}::uuid,${target}::uuid,${turn.turn_id}::uuid,${turn.origin_session_id}::uuid,'record',${row.id}::bigint,${row.seq}::bigint,${row.ordinal},
              ${turn.mailbox_position}::bigint,${row.kind === "entry" ? row.id : null}::bigint,${row.assistant_id}::bigint,${stored.id}::uuid,
              ${JSON.stringify(descriptor.fields)}::jsonb,${stored.bytes + (row.kind === "entry" ? row.body_bytes : 0)})`.execute(
            tx,
          );
        }
        const last = rows.at(-1)!;
        position = { seq: last.seq, ordinal: last.ordinal };
      }
    }
    after = Number(turns.rows.at(-1)!.mailbox_position);
  }
  return Number(anchor.mailbox_position);
}
