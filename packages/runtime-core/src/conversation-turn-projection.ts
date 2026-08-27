import {
  parseConversationTurnTranscriptResource,
  type PiCloudEvent,
  type ConversationTranscriptItemResource,
  type ConversationTurnTranscriptResource,
} from "@pi-cloud/protocol";

function toolItemIndex(
  items: readonly ConversationTranscriptItemResource[],
  toolCallId: string,
): number {
  return items.findIndex((item) => item.kind === "tool" && item.toolCallId === toolCallId);
}

/**
 * Reduces the durable public event history for one Turn into the bounded
 * semantic transcript used by conversation discovery. Pi SessionStorage
 * remains the model-context authority; PostgreSQL supplies the bounded live
 * tail and stores the canonical terminal view.
 */
export function projectConversationTurnTranscript(
  events: readonly PiCloudEvent[],
): ConversationTurnTranscriptResource {
  if (events.length === 0) {
    throw new TypeError("A conversation turn projection requires at least one event");
  }
  const first = events[0]!;
  if (first.turnId === null) {
    throw new TypeError("A conversation turn projection cannot contain a session-level event");
  }

  const items: ConversationTranscriptItemResource[] = [];
  let previousSequence = 0;
  let startedSequence: number | null = null;
  let terminalSequence: number | null = null;
  let stopReason: string | null = null;
  let failure: ConversationTurnTranscriptResource["failure"] = null;
  let cancellation: ConversationTurnTranscriptResource["cancellation"] = null;
  let workspacePatch: ConversationTurnTranscriptResource["workspacePatch"] = null;

  for (const event of events) {
    if (
      event.sessionId !== first.sessionId ||
      event.turnId !== first.turnId ||
      event.seq <= previousSequence
    ) {
      throw new TypeError(
        "Conversation turn projection events must share one identity and increase by sequence",
      );
    }
    previousSequence = event.seq;

    if (event.type === "turn.started") {
      startedSequence = event.seq;
      continue;
    }
    if (event.type === "assistant.text.delta") {
      const last = items.at(-1);
      if (last?.kind === "text") {
        items[items.length - 1] = {
          ...last,
          text: `${last.text}${event.payload.text}`,
          lastSequence: event.seq,
        };
      } else {
        items.push({
          kind: "text",
          text: event.payload.text,
          firstSequence: event.seq,
          lastSequence: event.seq,
        });
      }
      continue;
    }
    if (event.type === "tool.started") {
      const index = toolItemIndex(items, event.payload.toolCallId);
      if (index < 0) {
        items.push({
          kind: "tool",
          toolCallId: event.payload.toolCallId,
          toolName: event.payload.toolName,
          input: event.payload.input,
          status: "running",
          firstSequence: event.seq,
          startedAt: event.occurredAt,
        });
      } else {
        const existing = items[index]!;
        if (existing.kind !== "tool") throw new Error("Tool projection index was corrupted");
        items[index] = {
          ...existing,
          toolName: event.payload.toolName,
          input: event.payload.input,
          status: "running",
          startedAt: event.occurredAt,
        };
      }
      continue;
    }
    if (event.type === "tool.completed") {
      const index = toolItemIndex(items, event.payload.toolCallId);
      if (index < 0) {
        items.push({
          kind: "tool",
          toolCallId: event.payload.toolCallId,
          toolName: "unknown",
          input: null,
          ...(event.payload.output === undefined ? {} : { output: event.payload.output }),
          status: event.payload.outcome,
          firstSequence: event.seq,
          lastSequence: event.seq,
          startedAt: event.occurredAt,
          completedAt: event.occurredAt,
        });
      } else {
        const existing = items[index]!;
        if (existing.kind !== "tool") throw new Error("Tool projection index was corrupted");
        items[index] = {
          ...existing,
          ...(event.payload.output === undefined ? {} : { output: event.payload.output }),
          status: event.payload.outcome,
          lastSequence: event.seq,
          completedAt: event.occurredAt,
        };
      }
      continue;
    }
    if (event.type === "ui.notification") {
      items.push({
        kind: "notification",
        level: event.payload.level,
        message: event.payload.message,
        sequence: event.seq,
      });
      continue;
    }
    if (event.type === "context.compaction.started") {
      items.push({
        kind: "compaction",
        reason: event.payload.reason,
        status: "running",
        willRetry: false,
        firstSequence: event.seq,
      });
      continue;
    }
    if (event.type === "context.compaction.completed") {
      let index = -1;
      for (let itemIndex = items.length - 1; itemIndex >= 0; itemIndex -= 1) {
        const candidate = items[itemIndex]!;
        if (candidate.kind === "compaction" && candidate.status === "running") {
          index = itemIndex;
          break;
        }
      }
      const existing = index < 0 ? undefined : items[index];
      const completed = {
        kind: "compaction" as const,
        reason: event.payload.reason,
        status: event.payload.status,
        willRetry: event.payload.willRetry,
        ...(event.payload.tokensBefore === undefined
          ? {}
          : { tokensBefore: event.payload.tokensBefore }),
        ...(event.payload.estimatedTokensAfter === undefined
          ? {}
          : { estimatedTokensAfter: event.payload.estimatedTokensAfter }),
        firstSequence: existing?.kind === "compaction" ? existing.firstSequence : event.seq,
        lastSequence: event.seq,
      };
      if (index < 0) items.push(completed);
      else items[index] = completed;
      continue;
    }
    if (event.type === "model.sampling.retry.scheduled") {
      items.push({
        kind: "retry",
        nextSamplingAttempt: event.payload.nextSamplingAttempt,
        maximumSamplingAttempts: event.payload.maximumSamplingAttempts,
        delayMs: event.payload.delayMs,
        sequence: event.seq,
      });
      continue;
    }
    if (event.type === "turn.completed") {
      terminalSequence = event.seq;
      stopReason = event.payload.stopReason;
      workspacePatch = event.payload.workspacePatch ?? null;
      continue;
    }
    if (event.type === "turn.failed") {
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]!;
        if (item.kind === "tool" && item.status === "running") {
          items[index] = {
            ...item,
            status: "unknown",
            lastSequence: event.seq,
            completedAt: event.occurredAt,
          };
        } else if (item.kind === "compaction" && item.status === "running") {
          items[index] = {
            ...item,
            status: "failed",
            lastSequence: event.seq,
          };
        }
      }
      terminalSequence = event.seq;
      failure = event.payload;
      continue;
    }
    if (event.type === "turn.cancelled") {
      for (let index = 0; index < items.length; index += 1) {
        const item = items[index]!;
        if (item.kind === "tool" && item.status === "running") {
          items[index] = {
            ...item,
            status: "unknown",
            lastSequence: event.seq,
            completedAt: event.occurredAt,
          };
        } else if (item.kind === "compaction" && item.status === "running") {
          items[index] = {
            ...item,
            status: "aborted",
            lastSequence: event.seq,
          };
        }
      }
      terminalSequence = event.seq;
      stopReason = "cancelled";
      cancellation = event.payload;
    }
  }

  return parseConversationTurnTranscriptResource({
    schemaVersion: 1,
    throughSequence: events.at(-1)!.seq,
    items,
    startedSequence,
    terminalSequence,
    stopReason,
    failure,
    cancellation,
    workspacePatch,
  });
}
