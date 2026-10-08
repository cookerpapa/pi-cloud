import type { Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import {
  readHumanInputMetadataBatch,
  type StoredHumanInputs,
} from "@pi-cloud/pi-session-postgres/durable";
import {
  parseConversationTurnTranscriptResource,
  normalizeProviderHostedWebSearchAction,
  toolResultIsUnknown,
  type ConversationTurnTranscriptResource,
  type ConversationTranscriptItemResource,
  type AssistantMessagePhase,
  parseUserUploads,
  type UserUpload,
} from "@pi-cloud/protocol";
type JsonRecord = Record<string, unknown>;
type TerminalProjectionMetadata = Pick<
  ConversationTurnTranscriptResource,
  "throughSequence" | "terminalSequence" | "stopReason" | "failure" | "cancellation"
> & { occurredAt: string };
const record = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
function timestamp(value: Date | string | number): string {
  return new Date(value).toISOString();
}
function safeInteger(value: string | number | bigint, name: string): number {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error(`${name} is invalid`);
  return n;
}
function textPhase(value: JsonRecord): AssistantMessagePhase | undefined {
  if (typeof value.textSignature !== "string" || !value.textSignature.startsWith("{")) return;
  try {
    const s = JSON.parse(value.textSignature);
    if (s.v === 1 && ["commentary", "final_answer"].includes(s.phase)) return s.phase;
  } catch {
    /* Opaque provider signature. */
  }
}
function terminalMetadata(row: {
  seq: string;
  type: string;
  payload: JsonRecord;
  occurred_at: Date;
}): TerminalProjectionMetadata {
  const sequence = safeInteger(row.seq, "Terminal conversation sequence");
  const payload = row.payload;
  if (row.type === "turn.completed") {
    return {
      throughSequence: sequence,
      terminalSequence: sequence,
      stopReason: typeof payload.stopReason === "string" ? payload.stopReason : "stop",
      failure: null,
      cancellation: null,
      occurredAt: timestamp(row.occurred_at),
    };
  }
  if (row.type === "turn.failed") {
    return {
      throughSequence: sequence,
      terminalSequence: sequence,
      stopReason: null,
      failure: {
        code: typeof payload.code === "string" ? payload.code : "run_failed",
        message: typeof payload.message === "string" ? payload.message : "Agent Run failed",
        retryable: payload.retryable === true,
      },
      cancellation: null,
      occurredAt: timestamp(row.occurred_at),
    };
  }
  return {
    throughSequence: sequence,
    terminalSequence: sequence,
    stopReason: "cancelled",
    failure: null,
    cancellation: {
      reason: typeof payload.reason === "string" ? payload.reason : "user_request",
      forced: payload.forced === true,
    } as ConversationTurnTranscriptResource["cancellation"],
    occurredAt: timestamp(row.occurred_at),
  };
}

export type NativeHistoryRow = {
  id: string;
  task_kind?: string | null;
  seq: string;
  fields: Record<string, string>;
  body: string;
  committed_at: Date;
  pi_session_id?: string;
};
type HumanEntry = { inputId: string; text: string; uploads: UserUpload[] };
export function projectDurableTranscript(
  rows: readonly NativeHistoryRow[],
  terminal: TerminalProjectionMetadata,
  proposalOnly: ReadonlySet<string> = new Set(),
  humanEntries: ReadonlyMap<string, HumanEntry> = new Map(),
): ConversationTurnTranscriptResource {
  const items: ConversationTranscriptItemResource[] = [],
    proposals = new Map<string, { name: string; input: unknown }>();
  const sequence = terminal.throughSequence;
  for (const row of rows) {
    const entry = record(JSON.parse(row.body).value);
    if (!entry) throw new Error("Native history pointer is invalid");
    if (record(entry.state)?.status !== undefined) {
      const checkpoint = record(record(entry.state)?.checkpoint);
      if (
        checkpoint?.phase === "retry" &&
        typeof checkpoint.attempt === "number" &&
        checkpoint.attempt >= 1
      ) {
        items.push({ kind: "retry", nextSamplingAttempt: checkpoint.attempt + 1, sequence });
      }
      const outcome = record(record(entry.state)?.outcome),
        input = record(entry.input);
      if (record(entry.state)?.status === "terminal" && entry.kind === "pi.compaction") {
        const reason = input?.reason;
        if (reason === "manual" || reason === "threshold" || reason === "overflow")
          items.push({
            kind: "compaction",
            reason,
            status:
              outcome?.status === "completed"
                ? "completed"
                : outcome?.status === "aborted"
                  ? "aborted"
                  : "failed",
            willRetry: false,
            firstSequence: sequence,
            lastSequence: sequence,
          });
      } else if (entry.kind === "pi.tool") {
        const proposal =
          typeof input?.callId === "string" ? proposals.get(input.callId) : undefined;
        const running =
          record(entry.state)?.status === "running" && checkpoint?.phase === "execute";
        const ended = record(entry.state)?.status === "terminal";
        if (proposal && (running || ended))
          items.push({
            kind: "tool",
            toolCallId: `task:${row.id}`,
            toolName: proposal.name,
            input: running ? checkpoint.arguments : proposal.input,
            status: running ? "running" : "failed",
            ...(running
              ? {}
              : {
                  output: {
                    content: [
                      {
                        type: "text",
                        text:
                          outcome?.status === "aborted"
                            ? "Tool execution was aborted before a result was committed."
                            : "Tool execution ended without a committed result.",
                      },
                    ],
                  },
                  completedAt: timestamp(row.committed_at),
                  lastSequence: sequence,
                }),
            startedAt: timestamp(row.committed_at),
            firstSequence: sequence,
          });
      }
      continue;
    }
    const messages = Array.isArray(entry.model) ? entry.model : [];
    if (entry.kind === "pi.compaction") {
      const reason = record(entry.data)?.reason;
      if (reason === "manual" || reason === "threshold" || reason === "overflow")
        items.push({
          kind: "compaction",
          reason,
          status: "completed",
          willRetry: false,
          firstSequence: sequence,
          lastSequence: sequence,
        });
      continue;
    }
    for (const raw of messages) {
      const message = record(raw);
      if (!message) continue;
      const content = Array.isArray(message.content) ? message.content : [];
      if (message.role === "user") {
        const human = humanEntries.get(row.id);
        if (human)
          items.push({
            kind: "user",
            messageId: `entry:${row.id}`,
            inputId: human.inputId,
            text: human.text,
            ...(human.uploads.length ? { uploads: human.uploads } : {}),
            firstSequence: sequence,
            lastSequence: sequence,
          });
      } else if (message.role === "assistant") {
        proposals.clear();
        for (const [index, part] of content.entries()) {
          const block = record(part);
          if (!block) continue;
          if (
            !proposalOnly.has(row.id) &&
            block.type === "text" &&
            typeof block.text === "string" &&
            block.text
          ) {
            const phase = textPhase(block);
            items.push({
              kind: "text",
              messageId: `entry:${row.id}:${index}`,
              text: block.text,
              ...(phase ? { phase } : {}),
              firstSequence: sequence,
              lastSequence: sequence,
            });
          } else if (
            block.type === "toolCall" &&
            typeof block.id === "string" &&
            typeof block.name === "string"
          ) {
            proposals.set(block.id, { name: block.name, input: block.arguments ?? null });
          } else if (
            !proposalOnly.has(row.id) &&
            block.type === "providerHostedToolCall" &&
            block.toolName === "web_search"
          ) {
            const native = record(block.nativeItem);
            if (typeof native?.id !== "string") continue;
            const action = normalizeProviderHostedWebSearchAction(native);
            items.push({
              kind: "hosted_search",
              activityId: native.id,
              status: native.status === "failed" ? "failed" : "completed",
              ...(action ? { action } : {}),
              firstSequence: sequence,
              lastSequence: sequence,
            });
          }
        }
      } else if (
        message.role === "toolResult" &&
        typeof message.toolCallId === "string" &&
        typeof message.toolName === "string"
      ) {
        const at =
          typeof message.timestamp === "number"
            ? timestamp(message.timestamp)
            : timestamp(row.committed_at);
        items.push({
          kind: "tool",
          toolCallId:
            row.task_kind === JSON.stringify("pi.tool")
              ? `task:${entry.byTaskId}`
              : `entry:${row.id}`,
          toolName: message.toolName,
          input: proposals.get(message.toolCallId)?.input ?? null,
          output: {
            content,
            ...(message.details === undefined ? {} : { details: message.details }),
          },
          status: message.isError
            ? toolResultIsUnknown(message)
              ? "unknown"
              : "failed"
            : "completed",
          startedAt: at,
          completedAt: at,
          firstSequence: sequence,
          lastSequence: sequence,
        });
      }
    }
  }
  const { occurredAt: _at, ...metadata } = terminal;
  return parseConversationTurnTranscriptResource({
    schemaVersion: 1,
    ...metadata,
    items,
    startedSequence: Math.max(1, sequence - items.length),
  });
}

/** PG's thin Turn index points into the native JSON-text log. No second copy of
 * messages and no SDK execution is needed to reconstruct the public transcript. */
export async function readCanonicalPiTurnTranscripts(
  database: Kysely<Database>,
  input: { tenantId: string; turnIds: readonly string[] },
): Promise<ReadonlyMap<string, ConversationTurnTranscriptResource>> {
  if (!input.turnIds.length) return new Map();
  if (!database.isTransaction)
    return database
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute((tx) => readCanonicalPiTurnTranscripts(tx, input));
  const turnIds = [...new Set(input.turnIds)];
  const rows = await sql<NativeHistoryRow>`with own as (
      select r.* from pi_durable_records r
      where r.tenant_id=${input.tenantId}::uuid and r.fields->>'turn'=any(${turnIds}::text[])
        and (r.kind='entry' or r.kind='submission' or (r.kind='task' and r.fields->>'nativeKind'=any(${["pi.generation", "pi.tool", "pi.compaction"].map((value) => JSON.stringify(value))}::text[])))
        and exists(select 1 from runs t join sessions s on s.tenant_id=t.tenant_id and s.id=t.session_id
          where t.tenant_id=r.tenant_id and t.turn_id::text=r.fields->>'turn' and s.pi_session_id=r.session_id)
    ), history as (
      select r.id,r.session_id as pi_session_id,r.seq,r.ordinal,r.fields,l.body,c.committed_at,task.fields->>'nativeKind' as task_kind
      from own r join pi_durable_log l using(tenant_id,session_id,seq,ordinal)
        join pi_durable_commits c using(tenant_id,session_id,seq)
        left join pi_durable_records task on task.tenant_id=r.tenant_id and task.session_id=r.session_id
          and task.id=(r.fields->>'task')::bigint and task.kind='task'
      where r.kind in ('entry','submission')
      union all
      select r.id,r.session_id as pi_session_id,l.seq,l.ordinal,r.fields,l.body,c.committed_at,null::text as task_kind
      from own r join pi_durable_log l on l.tenant_id=r.tenant_id and l.session_id=r.session_id and l.record_id=r.id
        join pi_durable_commits c on c.tenant_id=l.tenant_id and c.session_id=l.session_id and c.seq=l.seq
      where r.kind='task' and l.record_kind='task' and l.phase=${JSON.stringify("retry")}
      union all
      select r.id,r.session_id as pi_session_id,r.seq,r.ordinal,r.fields,l.body,c.committed_at,null::text as task_kind
      from own r join pi_durable_log l using(tenant_id,session_id,seq,ordinal)
        join pi_durable_commits c using(tenant_id,session_id,seq)
      where r.kind='task' and (r.fields->>'status'='terminal' or (r.fields->>'nativeKind'=${JSON.stringify("pi.tool")} and r.fields->>'status'='running'))
        and r.fields->>'nativeKind'=any(${["pi.tool", "pi.compaction"].map((value) => JSON.stringify(value))}::text[])
        and not exists(select 1 from own result where result.kind='entry' and result.session_id=r.session_id and result.fields->>'task'=r.id::text)
    ) select * from history order by seq,ordinal`.execute(database);
  const requests = rows.rows.flatMap((row) => {
    const write = JSON.parse(row.body) as {
      type: string;
      value: { requestId?: string; entry?: number; conversationId?: number };
    };
    return write.type === "submission" &&
      write.value.requestId?.startsWith("input-") &&
      write.value.entry !== undefined &&
      row.pi_session_id &&
      row.fields.run
      ? [
          {
            row,
            inputId: write.value.requestId,
            entryId: String(write.value.entry),
            runId: row.fields.run,
            piSessionId: row.pi_session_id,
            conversationId: Number(write.value.conversationId),
          },
        ]
      : [];
  });
  const metadata = new Map<string, StoredHumanInputs>();
  for (const piSessionId of new Set(requests.map((request) => request.piSessionId))) {
    const group = requests.filter((request) => request.piSessionId === piSessionId);
    const loaded = await readHumanInputMetadataBatch(
      database,
      { tenantId: input.tenantId, sessionId: piSessionId },
      [
        ...new Map(
          group.map((request) => [
            request.runId,
            { runId: request.runId, conversationId: request.conversationId },
          ]),
        ).values(),
      ],
    );
    for (const [run, value] of loaded) metadata.set(run, value);
  }
  const humanEntries = new Map<string, Map<string, HumanEntry>>();
  for (const request of requests) {
    const record = metadata.get(request.runId)?.inputs[request.inputId];
    if (!record) continue;
    const turn = request.row.fields.turn!;
    const entries = humanEntries.get(turn) ?? new Map<string, HumanEntry>();
    entries.set(request.entryId, {
      inputId: request.inputId,
      text: record.text,
      uploads: parseUserUploads(record.uploads),
    });
    humanEntries.set(turn, entries);
  }
  const terminalRows = await database
    .selectFrom("session_terminal_events")
    .select(["turn_id", "seq", "type", "payload", "occurred_at"])
    .where("tenant_id", "=", input.tenantId)
    .where("turn_id", "in", turnIds)
    .execute();
  const activeRows = await database
    .selectFrom("runs")
    .select(["turn_id", "output_display_seq", "output_display_native_seq"])
    .where("tenant_id", "=", input.tenantId)
    .where("turn_id", "in", turnIds)
    .execute();
  const terminals = new Map(terminalRows.map((row) => [row.turn_id, row])),
    active = new Map(activeRows.map((row) => [row.turn_id, row]));
  const grouped = new Map<string, NativeHistoryRow[]>();
  for (const row of rows.rows) {
    const turn = row.fields.turn!;
    const list = grouped.get(turn) ?? [];
    list.push(row);
    grouped.set(turn, list);
  }
  const result = new Map<string, ConversationTurnTranscriptResource>();
  for (const turn of turnIds) {
    const terminal = terminals.get(turn),
      current = active.get(turn);
    if (terminal)
      result.set(
        turn,
        projectDurableTranscript(
          grouped.get(turn) ?? [],
          terminalMetadata(terminal),
          new Set(),
          humanEntries.get(turn),
        ),
      );
    else if (current && (Number(current.output_display_seq) > 0 || humanEntries.get(turn)?.size)) {
      const all = grouped.get(turn) ?? [],
        proposalOnly = new Set<string>();
      const running = new Set(
        all.filter(
          (row) =>
            row.fields.nativeKind === JSON.stringify("pi.tool") && row.fields.status === "running",
        ),
      );
      for (const row of running) {
        const task = record(JSON.parse(row.body).value),
          input = record(task?.input);
        if (typeof input?.assistant === "number") proposalOnly.add(String(input.assistant));
      }
      // Only recover Tool metadata beyond display coverage. Text in the same
      // assistant stays covered by its original stream boundary.
      for (const row of all)
        if (Number(row.seq) <= Number(current.output_display_native_seq))
          proposalOnly.delete(row.id);
      result.set(
        turn,
        projectDurableTranscript(
          all.filter(
            (row) =>
              Number(row.seq) <= Number(current.output_display_native_seq) ||
              // An already projected execute checkpoint is current native state.
              // It can show a Tool in a plain GET before its lossy/live start is
              // covered. The stable native task ID merges with the SSE start.
              row.fields.role === "user" ||
              (Number(current.output_display_seq) > 0 &&
                (running.has(row) || proposalOnly.has(row.id))),
          ),
          {
            throughSequence: Number(current.output_display_seq),
            terminalSequence: null,
            stopReason: null,
            failure: null,
            cancellation: null,
            occurredAt: new Date().toISOString(),
          },
          proposalOnly,
          humanEntries.get(turn),
        ),
      );
    }
  }
  return result;
}
