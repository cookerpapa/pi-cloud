import type { Database } from "@pi-cloud/database";
import { PI_MODEL_RETRY_CUSTOM_TYPE } from "@pi-cloud/pi-session-postgres";
import {
  parseConversationTurnTranscriptResource,
  type ConversationTranscriptItemResource,
  type ConversationTurnTranscriptResource,
} from "@pi-cloud/protocol";
import { normalizeProviderHostedWebSearchAction, toolResultIsUnknown } from "@pi-cloud/protocol";
import type { Kysely, Transaction } from "kysely";

export const INTERRUPTED_ASSISTANT_PREFIX_CUSTOM_TYPE = "pi-cloud.interrupted_assistant_prefix";

type JsonRecord = Record<string, unknown>;
type TerminalProjectionMetadata = Pick<
  ConversationTurnTranscriptResource,
  "throughSequence" | "terminalSequence" | "stopReason" | "failure" | "cancellation"
> & { occurredAt: string };
type DraftItem =
  | { kind: "text"; text: string }
  | {
      kind: "hosted_search";
      activityId: string;
      status: "completed" | "failed";
      action?: import("@pi-cloud/protocol").ProviderHostedWebSearchAction;
    }
  | {
      kind: "tool";
      toolCallId: string;
      toolName: string;
      input: unknown;
      output?: unknown;
      status: "running" | "completed" | "failed" | "unknown";
      startedAt: string;
      completedAt?: string;
    }
  | {
      kind: "compaction";
      reason: "threshold";
      status: "completed";
      willRetry: false;
      tokensBefore?: number;
    }
  | {
      kind: "retry";
      nextSamplingAttempt: number;
      maximumSamplingAttempts?: number;
      delayMs?: number;
    };

function record(value: unknown): JsonRecord | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined;
}

function safeInteger(value: string | number | bigint, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} is invalid`);
  return parsed;
}

function timestamp(value: string | Date | number): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf()))
    throw new Error("Canonical conversation timestamp is invalid");
  return parsed.toISOString();
}

function messageFromEntry(payload: unknown): JsonRecord | undefined {
  const entry = record(payload);
  return entry?.type === "message" ? record(entry.message) : undefined;
}

function textParts(message: JsonRecord | undefined): string[] {
  if (!Array.isArray(message?.content)) return [];
  return message.content.flatMap((part) => {
    const candidate = record(part);
    return candidate?.type === "text" && typeof candidate.text === "string" ? [candidate.text] : [];
  });
}

function interruptedPrefix(payload: unknown): string | undefined {
  const entry = record(payload);
  if (entry?.type !== "custom" || entry.customType !== INTERRUPTED_ASSISTANT_PREFIX_CUSTOM_TYPE) {
    return undefined;
  }
  const data = record(entry.data);
  return typeof data?.text === "string" && data.text.length > 0 ? data.text : undefined;
}

function retryFact(payload: unknown): Extract<DraftItem, { kind: "retry" }> | undefined {
  const entry = record(payload);
  if (entry?.type !== "custom" || entry.customType !== PI_MODEL_RETRY_CUSTOM_TYPE) return undefined;
  const data = record(entry.data);
  if (
    typeof data?.nextSamplingAttempt !== "number" ||
    !Number.isSafeInteger(data.nextSamplingAttempt) ||
    data.nextSamplingAttempt < 1
  ) {
    return undefined;
  }
  const maximumSamplingAttempts =
    typeof data.maximumSamplingAttempts === "number" &&
    Number.isSafeInteger(data.maximumSamplingAttempts) &&
    data.maximumSamplingAttempts >= data.nextSamplingAttempt
      ? data.maximumSamplingAttempts
      : undefined;
  const delayMs =
    typeof data.delayMs === "number" &&
    Number.isSafeInteger(data.delayMs) &&
    data.delayMs >= 0 &&
    data.delayMs <= 300_000
      ? data.delayMs
      : undefined;
  return {
    kind: "retry",
    nextSamplingAttempt: data.nextSamplingAttempt,
    ...(maximumSamplingAttempts === undefined ? {} : { maximumSamplingAttempts }),
    ...(delayMs === undefined ? {} : { delayMs }),
  };
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

function outputValue(message: JsonRecord): unknown {
  const content = Array.isArray(message.content) ? message.content : [];
  return {
    content,
    ...(message.details === undefined ? {} : { details: message.details }),
  };
}

function projectPiEntries(
  rows: readonly { seq: string; timestamp_ms: string; payload: JsonRecord }[],
  terminal: ReturnType<typeof terminalMetadata>,
): ConversationTurnTranscriptResource {
  const drafts: DraftItem[] = [];
  const tools = new Map<string, number>();
  const proposed = new Map<string, { name: string; input: unknown }>();
  for (const row of rows) {
    const payload = record(row.payload);
    const occurredAt = timestamp(safeInteger(row.timestamp_ms, "Pi entry timestamp"));
    if (
      payload?.type === "tool_started" &&
      typeof payload.toolCallId === "string" &&
      typeof payload.toolName === "string"
    ) {
      if (!tools.has(payload.toolCallId)) {
        tools.set(payload.toolCallId, drafts.length);
        drafts.push({
          kind: "tool",
          toolCallId: payload.toolCallId,
          toolName: payload.toolName,
          input: payload.effectiveArgs ?? null,
          status: "running",
          startedAt: occurredAt,
        });
      }
      continue;
    }
    if (payload?.type === "compaction") {
      drafts.push({
        kind: "compaction",
        reason: "threshold",
        status: "completed",
        willRetry: false,
        ...(typeof payload.tokensBefore === "number" &&
        Number.isSafeInteger(payload.tokensBefore) &&
        payload.tokensBefore >= 0
          ? { tokensBefore: payload.tokensBefore }
          : {}),
      });
      continue;
    }
    const retry = retryFact(payload);
    if (retry !== undefined) {
      drafts.push(retry);
      continue;
    }
    const message = messageFromEntry(row.payload);
    if (message?.role === "assistant") {
      if (!Array.isArray(message.content)) continue;
      for (const part of message.content) {
        const candidate = record(part);
        if (
          candidate?.type === "text" &&
          typeof candidate.text === "string" &&
          candidate.text.length > 0
        ) {
          const last = drafts.at(-1);
          if (last?.kind === "text") last.text += candidate.text;
          else drafts.push({ kind: "text", text: candidate.text });
          continue;
        }
        if (candidate?.type === "providerHostedToolCall" && candidate.toolName === "web_search") {
          const nativeItem = record(candidate.nativeItem);
          if (typeof nativeItem?.id !== "string" || nativeItem.id.length === 0) continue;
          const action = normalizeProviderHostedWebSearchAction(nativeItem);
          drafts.push({
            kind: "hosted_search",
            activityId: nativeItem.id,
            status: nativeItem.status === "failed" ? "failed" : "completed",
            ...(action === undefined ? {} : { action }),
          });
          continue;
        }
        if (
          candidate?.type === "toolCall" &&
          typeof candidate.id === "string" &&
          typeof candidate.name === "string"
        ) {
          // A proposed call is not an execution intent. Its arguments can still
          // explain a validation-failure result which never acquired an intent.
          proposed.set(candidate.id, { name: candidate.name, input: candidate.arguments ?? null });
        }
      }
      continue;
    }
    if (
      message?.role === "toolResult" &&
      typeof message.toolCallId === "string" &&
      typeof message.toolName === "string"
    ) {
      const index = tools.get(message.toolCallId);
      const status =
        message.isError === true
          ? toolResultIsUnknown(message)
            ? "unknown"
            : "failed"
          : "completed";
      if (index === undefined) {
        tools.set(message.toolCallId, drafts.length);
        drafts.push({
          kind: "tool",
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          input: proposed.get(message.toolCallId)?.input ?? null,
          output: outputValue(message),
          status,
          startedAt: occurredAt,
          completedAt: occurredAt,
        });
      } else {
        const current = drafts[index];
        if (current?.kind === "tool") {
          drafts[index] = {
            ...current,
            output: outputValue(message),
            status,
            completedAt: occurredAt,
          };
        }
      }
      continue;
    }
    const prefix = interruptedPrefix(row.payload);
    if (prefix !== undefined) {
      const last = drafts.at(-1);
      if (last?.kind === "text") last.text += prefix;
      else drafts.push({ kind: "text", text: prefix });
    }
  }

  const firstSequence = Math.max(1, terminal.throughSequence - drafts.length);
  const items = drafts.map((item, index): ConversationTranscriptItemResource => {
    const sequence = Math.min(terminal.throughSequence, firstSequence + index);
    if (item.kind === "text") {
      return { ...item, firstSequence: sequence, lastSequence: sequence };
    }
    if (item.kind === "hosted_search") {
      return { ...item, firstSequence: sequence, lastSequence: sequence };
    }
    if (item.kind === "compaction") {
      return { ...item, firstSequence: sequence, lastSequence: sequence };
    }
    if (item.kind === "retry") return { ...item, sequence };
    return {
      ...item,
      firstSequence: sequence,
      ...(item.completedAt === undefined ? {} : { lastSequence: sequence }),
    };
  });
  if (terminal.failure !== null || terminal.cancellation !== null) {
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index]!;
      if (item.kind === "tool" && item.status === "running") {
        items[index] = {
          ...item,
          status: "unknown",
          lastSequence: terminal.throughSequence,
          completedAt: terminal.occurredAt,
        };
      }
    }
  }
  const { occurredAt: _occurredAt, ...terminalResource } = terminal;
  return parseConversationTurnTranscriptResource({
    schemaVersion: 1,
    ...terminalResource,
    items,
    startedSequence: firstSequence,
  });
}

export async function readCanonicalPiTurnTranscripts(
  database: Kysely<Database>,
  input: { tenantId: string; turnIds: readonly string[] },
): Promise<ReadonlyMap<string, ConversationTurnTranscriptResource>> {
  if (!database.isTransaction)
    return database
      .transaction()
      .setIsolationLevel("repeatable read")
      .execute((tx) => readCanonicalPiTurnTranscripts(tx, input));
  const turnIds = [...new Set(input.turnIds)];
  if (turnIds.length === 0) return new Map();
  const [entries, intentRecords, durableTerminalRows, activeRows] = await Promise.all([
    database
      .selectFrom("pi_session_entries")
      .select(["turn_id", "seq", "timestamp_ms", "payload"])
      .where("tenant_id", "=", input.tenantId)
      .where("turn_id", "in", turnIds)
      .orderBy("seq", "asc")
      .execute(),
    database
      .selectFrom("pi_session_records")
      .select(["turn_id", "seq", "timestamp_ms", "payload"])
      .where("tenant_id", "=", input.tenantId)
      .where("turn_id", "in", turnIds)
      .where("type", "=", "tool_started")
      .orderBy("seq", "asc")
      .execute(),
    database
      .selectFrom("session_terminal_events")
      .select(["turn_id", "seq", "type", "payload", "occurred_at", "interrupted_prefix"])
      .where("tenant_id", "=", input.tenantId)
      .where("turn_id", "in", turnIds)
      .execute(),
    database
      .selectFrom("runs as run")
      .innerJoin("run_attempts as attempt", "attempt.id", "run.current_attempt_id")
      .select(["run.turn_id", "attempt.output_display_seq", "attempt.output_display_native_seq"])
      .where("run.tenant_id", "=", input.tenantId)
      .where("run.turn_id", "in", turnIds)
      .execute(),
  ]);
  const activeByTurn = new Map(activeRows.map((r) => [r.turn_id, r]));
  const terminalByTurn = new Map<string, (typeof durableTerminalRows)[number]>(
    durableTerminalRows.map((row) => [row.turn_id, row]),
  );
  const entriesByTurn = new Map<string, typeof entries>();
  for (const entry of [...entries, ...intentRecords].sort(
    (a, b) => Number(a.seq) - Number(b.seq),
  )) {
    if (entry.turn_id === null) continue;
    if (
      !terminalByTurn.has(entry.turn_id) &&
      Number(entry.seq) > Number(activeByTurn.get(entry.turn_id)?.output_display_native_seq ?? 0)
    )
      continue;
    const existing = entriesByTurn.get(entry.turn_id) ?? [];
    existing.push(entry);
    entriesByTurn.set(entry.turn_id, existing);
  }
  const result = new Map<string, ConversationTurnTranscriptResource>();
  for (const turnId of turnIds) {
    const terminalRow = terminalByTurn.get(turnId);
    const piEntries = entriesByTurn.get(turnId) ?? [];
    if (terminalRow === undefined) {
      const active = activeByTurn.get(turnId);
      if (active && Number(active.output_display_seq) > 0)
        result.set(
          turnId,
          projectPiEntries(piEntries, {
            throughSequence: Number(active.output_display_seq),
            terminalSequence: null,
            stopReason: null,
            failure: null,
            cancellation: null,
            occurredAt: new Date().toISOString(),
          }),
        );
      continue;
    }
    if (terminalRow.interrupted_prefix !== null)
      piEntries.push({
        turn_id: turnId,
        seq: String(Number(piEntries.at(-1)?.seq ?? 0) + 1),
        timestamp_ms: String(terminalRow.occurred_at.valueOf()),
        payload: {
          type: "custom",
          customType: INTERRUPTED_ASSISTANT_PREFIX_CUSTOM_TYPE,
          data: { text: terminalRow.interrupted_prefix },
        },
      });
    if (piEntries.length > 0) {
      result.set(turnId, projectPiEntries(piEntries, terminalMetadata(terminalRow)));
      continue;
    }
    const terminal = terminalMetadata(terminalRow);
    const { occurredAt: _occurredAt, ...terminalResource } = terminal;
    result.set(
      turnId,
      parseConversationTurnTranscriptResource({
        schemaVersion: 1,
        ...terminalResource,
        items: [],
        startedSequence: terminal.throughSequence,
      }),
    );
  }
  return result;
}

export async function readInterruptedAssistantPrefix(
  transaction: Transaction<Database>,
  input: {
    tenantId: string;
    sessionId: string;
    turnId: string;
    transcript: ConversationTurnTranscriptResource;
  },
): Promise<string | null> {
  const visibleText = input.transcript.items
    .filter(
      (item): item is Extract<ConversationTranscriptItemResource, { kind: "text" }> =>
        item.kind === "text",
    )
    .map((item) => item.text)
    .join("");
  if (visibleText.length === 0) return null;
  const existingRows = await transaction
    .selectFrom("pi_session_entries")
    .select("payload")
    .where("tenant_id", "=", input.tenantId)
    .where("turn_id", "=", input.turnId)
    .orderBy("seq", "asc")
    .execute();
  const canonicalText = existingRows
    .flatMap((row) => {
      const message = messageFromEntry(row.payload);
      return message?.role === "assistant"
        ? textParts(message)
        : (interruptedPrefix(row.payload) ?? []);
    })
    .join("");
  const missingText = visibleText.startsWith(canonicalText)
    ? visibleText.slice(canonicalText.length)
    : visibleText;
  return missingText || null;
}
