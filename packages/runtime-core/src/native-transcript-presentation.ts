import {
  parseConversationTurnTranscriptResource,
  normalizeProviderHostedWebSearchAction,
  toolResultIsUnknown,
  type ConversationTurnTranscriptResource,
  type ConversationTranscriptItemResource,
  type AssistantMessagePhase,
  toolContentView,
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
export function terminalMetadata(row: {
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
  imageSessionId?: string,
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
            block.type === "text" &&
            record(block.providerHostedTool)?.toolName === "web_search"
          ) {
            const native = record(record(block.providerHostedTool)?.nativeItem);
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
            content: imageSessionId ? toolContentView(imageSessionId, content) : content,
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
