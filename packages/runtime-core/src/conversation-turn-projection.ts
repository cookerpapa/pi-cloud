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
 * Reduces public display spans onto a canonical presentation seed. This does
 * not write Pi SessionStorage or turn UI search/preparation rows into model
 * tools. Native PG history remains the model-context authority.
 */
export function projectConversationTurnTranscript(
  events: readonly PiCloudEvent[],
  base?: ConversationTurnTranscriptResource,
): ConversationTurnTranscriptResource {
  if (events.length === 0) {
    if (base) return base;
    throw new TypeError("A conversation turn projection requires at least one event");
  }
  const first = events[0]!;
  if (first.turnId === null) {
    throw new TypeError("A conversation turn projection cannot contain a session-level event");
  }

  const items: ConversationTranscriptItemResource[] = [...(base?.items ?? [])];
  let previousSequence = base?.throughSequence ?? 0;
  let startedSequence: number | null = base?.startedSequence ?? null;
  let terminalSequence: number | null = base?.terminalSequence ?? null;
  let stopReason: string | null = base?.stopReason ?? null;
  let failure: ConversationTurnTranscriptResource["failure"] = base?.failure ?? null;
  let cancellation: ConversationTurnTranscriptResource["cancellation"] = base?.cancellation ?? null;

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
    if (event.type === "assistant.tool_call.preparing") {
      if (
        !items.some(
          (item) => item.kind === "tool_preparing" && item.toolCallId === event.payload.toolCallId,
        )
      )
        items.push({
          kind: "tool_preparing",
          toolCallId: event.payload.toolCallId,
          toolName: event.payload.toolName,
          firstSequence: event.seq,
          startedAt: event.occurredAt,
        });
      continue;
    }
    if (
      event.type === "provider.hosted_tool.started" ||
      event.type === "provider.hosted_tool.completed"
    ) {
      const at = items.findIndex(
        (item) => item.kind === "hosted_search" && item.activityId === event.payload.activityId,
      );
      const old = at < 0 ? undefined : items[at];
      const next: ConversationTranscriptItemResource = {
        kind: "hosted_search",
        activityId: event.payload.activityId,
        firstSequence: old && "firstSequence" in old ? old.firstSequence : event.seq,
        status: event.type === "provider.hosted_tool.started" ? "running" : event.payload.outcome,
        ...(event.type === "provider.hosted_tool.completed"
          ? {
              lastSequence: event.seq,
              ...(event.payload.action === undefined ? {} : { action: event.payload.action }),
            }
          : {}),
      };
      if (at < 0) items.push(next);
      else items[at] = next;
      continue;
    }
    if (event.type === "tool.started") {
      const preparing = items.findIndex(
        (item) => item.kind === "tool_preparing" && item.toolCallId === event.payload.toolCallId,
      );
      if (preparing >= 0) items.splice(preparing, 1);
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
      const preparing = items.findIndex(
        (item) => item.kind === "tool_preparing" && item.toolCallId === event.payload.toolCallId,
      );
      if (preparing >= 0) items.splice(preparing, 1);
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
      // PG may already contain the completed Compaction Entry while its later
      // public completion detail remains in the tail. Refine that item instead
      // of displaying the same compaction twice after a refresh.
      if (index < 0 && event.payload.status === "completed" && base) {
        for (let i = base.items.length - 1; i >= 0; i--)
          if (items[i]?.kind === "compaction") {
            index = i;
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
    items:
      terminalSequence === null
        ? items
        : items
            .filter((item) => item.kind !== "tool_preparing")
            .map((item) =>
              item.kind === "hosted_search" && item.status === "running"
                ? {
                    ...item,
                    status: failure || cancellation ? "failed" : "completed",
                    lastSequence: terminalSequence,
                  }
                : item,
            ),
    startedSequence,
    terminalSequence,
    stopReason,
    failure,
    cancellation,
  });
}
