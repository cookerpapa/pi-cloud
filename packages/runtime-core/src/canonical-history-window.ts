import { readFrozenHistoryWindow } from "./frozen-history-window.ts";
import { sql, type Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  readHumanInputPresentation,
  humanPresentationSliceCharacters,
} from "@pi-cloud/pi-session-postgres/durable";
import {
  HISTORY_PAGE_BYTES,
  HISTORY_PAGE_RECORDS,
  type ConversationTurnTranscriptResource,
  type ConversationTranscriptItemResource,
  type UserUpload,
} from "@pi-cloud/protocol";
import {
  projectDurableTranscript,
  type NativeHistoryRow,
  terminalMetadata,
} from "./native-transcript-presentation.ts";
import { encodeHistoryPosition, type HistoryPosition } from "./history-position.ts";

export type HistoryTurnSource = {
  turnId: string;
  originSessionId: string;
  piSessionId: string;
  operationKind: "chat" | "compact";
  frozen?: boolean;
  through?: { sequence: number; ordinal: number };
};
type Point = {
  id: string;
  seq: string;
  ordinal: number;
  fields: Record<string, string>;
  body_bytes: number;
  assistant_id: string | null;
  assistant_bytes: number;
  task_kind: string | null;
  turn_id: string;
  pi_session_id: string;
  origin_session_id: string;
  turn_index: string;
  header: boolean;
};
export type CanonicalHistoryWindow = {
  transcripts: ReadonlyMap<string, ConversationTurnTranscriptResource>;
  positions: HistoryPosition[];
  headers: ReadonlySet<string>;
  more: boolean;
  bytes: number;
  lastContinues: boolean;
};

/** Indexed seeks limit positions before body fetches. Tool intent is fetched by
 * native Task identity, including when its assistant is outside this page. */
export type HistoryWindowInput = {
  tenantId: string;
  sessionId: string;
  turns: readonly HistoryTurnSource[];
  direction: "before" | "after";
  position?: HistoryPosition;
  inclusive?: boolean;
  maxRecords?: number;
  maxBytes?: number;
  allowEmpty?: boolean;
};
export async function readCanonicalHistoryWindow(
  db: Kysely<Database>,
  input: HistoryWindowInput,
): Promise<CanonicalHistoryWindow> {
  const result: CanonicalHistoryWindow = {
    transcripts: new Map(),
    positions: [],
    headers: new Set(),
    more: false,
    bytes: 0,
    lastContinues: false,
  };
  const groups: HistoryTurnSource[][] = [];
  for (const turn of input.turns) {
    const last = groups.at(-1);
    if (last && Boolean(last[0]!.frozen) === Boolean(turn.frozen)) last.push(turn);
    else groups.push([turn]);
  }
  for (const [index, turns] of groups.entries()) {
    const remaining = HISTORY_PAGE_RECORDS - result.positions.length,
      budget = HISTORY_PAGE_BYTES - result.bytes;
    if (remaining <= 0 || budget <= 0) {
      result.more = true;
      break;
    }
    const options = {
      ...input,
      turns,
      maxRecords: remaining,
      maxBytes: budget,
      allowEmpty: result.positions.length > 0,
    };
    const page = turns[0]!.frozen
      ? await readFrozenHistoryWindow(db, options)
      : await readLiveHistoryWindow(db, options);
    for (const [id, t] of page.transcripts)
      (result.transcripts as Map<string, ConversationTurnTranscriptResource>).set(id, t);
    for (const id of page.headers) (result.headers as Set<string>).add(id);
    result.positions =
      input.direction === "before"
        ? [...page.positions, ...result.positions]
        : [...result.positions, ...page.positions];
    result.bytes += page.bytes;
    result.lastContinues = page.lastContinues;
    result.more = page.more || index < groups.length - 1;
    if (page.more) break;
  }
  return result;
}
async function readLiveHistoryWindow(
  db: Kysely<Database>,
  input: HistoryWindowInput,
): Promise<CanonicalHistoryWindow> {
  if (!input.turns.length)
    return {
      transcripts: new Map(),
      positions: [],
      headers: new Set(),
      more: false,
      bytes: 0,
      lastContinues: false,
    };
  const order = sql.raw(input.direction === "before" ? "desc" : "asc");
  const compare = sql.raw(
    input.direction === "before" ? (input.inclusive ? "<=" : "<") : input.inclusive ? ">=" : ">",
  );
  const edge = input.direction === "before" ? Number.MAX_SAFE_INTEGER : 0;
  const ordinalEdge = input.direction === "before" ? 2147483647 : 0;
  const anchor = input.position?.turnId ?? null;
  const upper = sql`(case when t.turn_id=${anchor}::uuid then ${input.position?.sequence ?? edge}::bigint else ${edge}::bigint end,
    case when t.turn_id=${anchor}::uuid then ${input.position?.ordinal ?? ordinalEdge}::int else ${ordinalEdge}::int end)`;
  const bound = (alias: string) =>
    sql`and (${sql.ref(alias + ".seq")},${sql.ref(alias + ".ordinal")}) ${compare} ${upper} and (${sql.ref(alias + ".seq")},${sql.ref(alias + ".ordinal")}) <= (t.scope_sequence,t.scope_ordinal)`;
  const metadata = await db
    .selectFrom("conversation_turns")
    .select(["turn_id", "output_display_seq", "output_display_native_seq"])
    .where("tenant_id", "=", input.tenantId)
    .where(
      "turn_id",
      "in",
      input.turns.map((t) => t.turnId),
    )
    .execute();
  const terminalRows = await db
    .selectFrom("session_terminal_events")
    .select(["turn_id", "seq", "type", "payload", "occurred_at"])
    .where("tenant_id", "=", input.tenantId)
    .where(
      "turn_id",
      "in",
      input.turns.map((t) => t.turnId),
    )
    .execute();
  const terminals = new Map(terminalRows.map((r) => [r.turn_id, r]));
  const metadataByTurn = new Map(metadata.map((r) => [r.turn_id, r]));
  const points = await sql<Point>`with scopes as (
    select r.*,s.pi_session_id,p.turn_index,p.scope_sequence,p.scope_ordinal,
      exists(select 1 from session_terminal_events terminal where terminal.tenant_id=r.tenant_id and terminal.turn_id=r.turn_id) as ended
    from unnest(${input.turns.map((t) => t.turnId)}::uuid[],${input.turns.map((t) => t.originSessionId)}::uuid[],${input.turns.map((t) => t.through?.sequence ?? Number.MAX_SAFE_INTEGER)}::bigint[],${input.turns.map((t) => t.through?.ordinal ?? 2147483647)}::int[]) with ordinality p(turn_id,session_id,scope_sequence,scope_ordinal,turn_index)
    join conversation_turns r on r.tenant_id=${input.tenantId}::uuid and r.turn_id=p.turn_id and r.session_id=p.session_id and r.pruned_at is null
    join sessions s on s.tenant_id=r.tenant_id and s.id=r.session_id and s.pruned_at is null
  ), points as (
    select t.turn_id,t.pi_session_id,t.session_id as origin_session_id,t.turn_index,p.*
    from scopes t cross join lateral (
      (select l.record_id as id,l.seq,l.ordinal,r.fields,l.body_bytes::int as body_bytes,false as header
        from pi_durable_log l join pi_durable_records r on r.tenant_id=l.tenant_id and r.session_id=l.session_id and r.id=l.record_id
        where t.operation_kind='chat' and l.tenant_id=t.tenant_id and l.session_id=t.pi_session_id and l.cloud_origin->>'turn'=t.turn_id::text
          and (l.record_kind='entry' or (l.record_kind='task' and l.phase='"retry"'))
          and r.fields->>'turn'=t.turn_id::text
          and (t.ended or l.seq<=t.output_display_native_seq or r.fields->>'role'='user')
          ${bound("l")}
        order by l.seq ${order},l.ordinal ${order} limit ${(input.maxRecords ?? HISTORY_PAGE_RECORDS) + 1})
      union all
      (select r.id,r.seq,r.ordinal,r.fields,l.body_bytes::int,false
        from pi_durable_records r join pi_durable_log l on l.tenant_id=r.tenant_id and l.session_id=r.session_id and l.seq=r.seq and l.ordinal=r.ordinal
        where t.operation_kind='chat' and r.tenant_id=t.tenant_id and r.session_id=t.pi_session_id and r.fields->>'turn'=t.turn_id::text and r.kind='task'
          and r.fields->>'nativeKind' in ('"pi.tool"','"pi.compaction"') and not(r.fields ? 'resultEntry')
          and (r.fields->>'status'='terminal' or (r.fields->>'nativeKind'='"pi.tool"' and r.fields->>'status'='running' and t.output_display_seq>0))
          and not exists(select 1 from pi_durable_records receipt where receipt.tenant_id=r.tenant_id and receipt.session_id=r.session_id and receipt.id=(r.fields->>'resultSubmission')::bigint and receipt.fields ? 'entry')
          and not exists(select 1 from pi_durable_records result where result.tenant_id=r.tenant_id and result.session_id=r.session_id
            and result.kind='entry' and result.fields->>'task'=r.id::text)
          ${bound("r")}
        order by r.seq ${order},r.ordinal ${order} limit ${(input.maxRecords ?? HISTORY_PAGE_RECORDS) + 1})
      union all
      select 0::bigint,0::bigint,0,'{}'::jsonb,
        coalesce(octet_length(t.input_text),0)+coalesce(octet_length(t.input_source),0)+octet_length(t.input_uploads::text)+2048,true
        where (0::bigint,0::int) ${compare} ${upper} or (${input.direction === "after" && input.position === undefined})
    ) p
    order by t.turn_index,p.seq ${order},p.ordinal ${order} limit ${(input.maxRecords ?? HISTORY_PAGE_RECORDS) + 1}
  ) select b.id::text,b.seq::text,b.ordinal,b.fields,b.body_bytes,b.header,b.turn_id::text,b.pi_session_id,b.origin_session_id::text,b.turn_index::text,
    coalesce(exact.id,a.id)::text as assistant_id,coalesce(ab.body_bytes,0)::int as assistant_bytes,task.fields->>'nativeKind' as task_kind
  from points b
  left join pi_durable_records task on task.tenant_id=${input.tenantId}::uuid and task.session_id=b.pi_session_id and task.id=(b.fields->>'task')::bigint and task.kind='task'
  left join pi_durable_records exact on exact.tenant_id=${input.tenantId}::uuid and exact.session_id=b.pi_session_id
    and exact.kind='entry' and exact.id=coalesce(b.fields->>'assistant',task.fields->>'assistant')::bigint
  left join lateral (
    select candidate.id,candidate.seq,candidate.ordinal from pi_durable_records candidate
    where candidate.tenant_id=${input.tenantId}::uuid and candidate.session_id=b.pi_session_id and candidate.kind='entry'
      and coalesce(b.fields->>'assistant',task.fields->>'assistant') is null and b.fields->>'role'='toolResult'
      and candidate.fields->>'conversation'=b.fields->>'conversation' and candidate.fields->>'role'='assistant' and candidate.id<b.id
    order by candidate.id desc limit 1
  ) a on true
  left join pi_durable_log ab on ab.tenant_id=${input.tenantId}::uuid and ab.session_id=b.pi_session_id and ab.seq=coalesce(exact.seq,a.seq) and ab.ordinal=coalesce(exact.ordinal,a.ordinal)
  order by b.turn_index,b.seq ${order},b.ordinal ${order}`.execute(db);
  const selected: Point[] = [];
  let bytes = 0;
  for (const p of points.rows) {
    const human = p.fields.role === "user" ? humanPresentationSliceCharacters(p.body_bytes) * 4 : 0;
    const cost = p.body_bytes + p.assistant_bytes + human + 1024;
    if (
      selected.length >= (input.maxRecords ?? HISTORY_PAGE_RECORDS) ||
      bytes + cost > (input.maxBytes ?? HISTORY_PAGE_BYTES)
    )
      break;
    bytes += cost;
    selected.push(p);
  }
  if (!selected.length && points.rows.length && !input.allowEmpty)
    throw new Error("History record exceeds the native presentation page boundary");
  const bodyPoints = selected.filter((p) => !p.header);
  const rows = bodyPoints.length
    ? await sql<
        NativeHistoryRow & { ordinal: number; pi_session_id: string }
      >`select l.record_id::text as id,l.seq::text,l.ordinal,r.fields,l.body,l.committed_at,l.session_id as pi_session_id
    from unnest(${bodyPoints.map((r) => r.pi_session_id)}::text[],${bodyPoints.map((r) => r.seq)}::bigint[],${bodyPoints.map((r) => r.ordinal)}::int[]) p(session_id,seq,ordinal)
    join pi_durable_log l on l.tenant_id=${input.tenantId}::uuid and l.session_id=p.session_id and l.seq=p.seq and l.ordinal=p.ordinal
    join pi_durable_records r on r.tenant_id=l.tenant_id and r.session_id=l.session_id and r.id=l.record_id
    `.execute(db)
    : { rows: [] };
  const assistantKeys = [
    ...new Map(
      bodyPoints.flatMap((r) =>
        r.assistant_id
          ? [
              [
                r.pi_session_id + ":" + r.assistant_id,
                { session: r.pi_session_id, id: r.assistant_id },
              ] as const,
            ]
          : [],
      ),
    ).values(),
  ];
  const dependencies = assistantKeys.length
    ? await sql<
        NativeHistoryRow & { pi_session_id: string }
      >`select r.id::text,r.seq::text,r.ordinal,r.fields,l.body,l.committed_at,r.session_id as pi_session_id
    from unnest(${assistantKeys.map((r) => r.session)}::text[],${assistantKeys.map((r) => r.id)}::bigint[]) p(session_id,id)
    join pi_durable_records r on r.tenant_id=${input.tenantId}::uuid and r.session_id=p.session_id and r.id=p.id and r.kind='entry'
    join pi_durable_log l on l.tenant_id=r.tenant_id and l.session_id=r.session_id and l.seq=r.seq and l.ordinal=r.ordinal
    `.execute(db)
    : { rows: [] };
  const users = bodyPoints.filter((r) => r.fields.role === "user");
  const inputs = users.length
    ? await sql<{
        id: string;
        session_id: string;
        fields: Record<string, string>;
      }>`select r.id::text,r.session_id,r.fields
    from unnest(${users.map((u) => u.pi_session_id)}::text[],${users.map((u) => u.id)}::text[]) p(session_id,entry_id)
    join pi_durable_records r on r.tenant_id=${input.tenantId}::uuid and r.session_id=p.session_id and r.kind='submission' and r.fields->>'entry'=p.entry_id`.execute(
        db,
      )
    : { rows: [] };
  const humanEntries = new Map<
    string,
    Map<string, { inputId: string; text: string; uploads: UserUpload[] }>
  >();
  for (const scope of new Set(users.map((u) => u.pi_session_id))) {
    const requests = inputs.rows
      .filter((r) => r.session_id === scope)
      .flatMap((row) => {
        const id = row.fields.request ? JSON.parse(row.fields.request) : undefined;
        const user = users.find((u) => u.pi_session_id === scope && u.id === row.fields.entry);
        return typeof id === "string" && id.startsWith("input-") && user && row.fields.run
          ? [
              {
                inputId: id,
                nativeId: row.id,
                runId: row.fields.run,
                conversationId: Number(row.fields.conversation),
                entryBytes: user.body_bytes,
                entryId: user.id,
              },
            ]
          : [];
      });
    const presentation = await readHumanInputPresentation(
      db,
      { tenantId: input.tenantId, sessionId: scope },
      requests,
    );
    const map = new Map<string, { inputId: string; text: string; uploads: UserUpload[] }>();
    for (const r of requests) {
      const v = presentation.get(r.inputId)!;
      map.set(r.entryId, { inputId: r.inputId, text: v.text, uploads: v.uploads as UserUpload[] });
    }
    humanEntries.set(scope, map);
  }
  const ordered = input.direction === "before" ? [...selected].reverse() : selected;
  const result = new Map<string, ConversationTurnTranscriptResource>();
  const positions: HistoryPosition[] = [];
  const headers = new Set<string>();
  const boundary = (id: string) => {
    const meta = metadataByTurn.get(id)!,
      terminal = terminals.get(id);
    return terminal
      ? terminalMetadata(terminal)
      : {
          throughSequence: Number(meta.output_display_seq),
          terminalSequence: null,
          stopReason: null,
          failure: null,
          cancellation: null,
          occurredAt: new Date().toISOString(),
        };
  };
  for (const p of ordered) {
    const position: HistoryPosition = {
      version: 2,
      storageId: p.pi_session_id,
      sessionId: input.sessionId,
      originSessionId: p.origin_session_id,
      turnId: p.turn_id,
      sequence: Number(p.seq),
      ordinal: p.ordinal,
    };
    positions.push(position);
    if (p.header) {
      headers.add(p.turn_id);
      continue;
    }
    const row = rows.rows.find(
      (r) => r.pi_session_id === p.pi_session_id && r.seq === p.seq && r.ordinal === p.ordinal,
    );
    if (!row) throw new Error("History body position disappeared");
    const dependency = p.assistant_id
      ? dependencies.rows.find(
          (r) => r.pi_session_id === p.pi_session_id && r.id === p.assistant_id,
        )
      : undefined;
    if (p.assistant_id && !dependency) throw new Error("Tool assistant dependency is missing");
    const projected = projectDurableTranscript(
      [...(dependency ? [dependency] : []), { ...row, task_kind: p.task_kind }],
      boundary(p.turn_id),
      new Set(dependency ? [dependency.id] : []),
      humanEntries.get(p.pi_session_id),
      input.sessionId,
    );
    const transcript = result.get(p.turn_id) ?? {
      ...projectDurableTranscript([], boundary(p.turn_id)),
      items: [],
    };
    transcript.items.push(
      ...projected.items.map((item): ConversationTranscriptItemResource => ({
        ...item,
        historyCursor: encodeHistoryPosition(position),
      })),
    );
    result.set(p.turn_id, transcript);
  }
  for (const id of headers)
    if (!result.has(id)) result.set(id, projectDurableTranscript([], boundary(id)));
  return {
    transcripts: result,
    positions,
    headers,
    more: selected.length < points.rows.length,
    bytes,
    lastContinues:
      selected.length > 0 && points.rows[selected.length]?.turn_id === selected.at(-1)!.turn_id,
  };
}
