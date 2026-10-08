import type { TranscriptItem } from "./session-view.ts";
import type { ToolTranscriptItem } from "./ToolActivity.tsx";

export type ConversationPresentationRow =
  | { kind: "user"; key: string; item: Extract<TranscriptItem, { kind: "user" }> }
  | {
      kind: "text";
      key: string;
      item: Extract<TranscriptItem, { kind: "text" }>;
      processNarration: boolean;
    }
  | {
      kind: "activity";
      key: string;
      items: readonly ToolTranscriptItem[];
    }
  | {
      kind: "hosted_search";
      key: string;
      items: readonly Extract<TranscriptItem, { kind: "hosted_search" }>[];
    }
  | {
      kind: "item";
      key: string;
      item: Exclude<TranscriptItem, { kind: "text" } | { kind: "tool" }>;
    };

/**
 * Derives stable presentation rows from the canonical transcript. Transport,
 * reducer and rendering concerns stay separate: adjacent Tools can be folded
 * without changing their Pi ordering or durable identities.
 */
export function deriveConversationPresentationRows(
  items: readonly TranscriptItem[],
): readonly ConversationPresentationRow[] {
  const lastTools: number[] = [];
  let lastTool = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.kind === "user") lastTool = -1;
    else if (items[i]!.kind === "tool" && lastTool < 0) lastTool = i;
    lastTools[i] = lastTool;
  }
  const rows: ConversationPresentationRow[] = [];
  let index = 0;
  while (index < items.length) {
    const item = items[index]!;
    if (item.kind === "user") {
      rows.push({ kind: "user", key: item.key, item });
      index++;
      continue;
    }
    if (item.kind === "text") {
      rows.push({
        kind: "text",
        key: item.key,
        item,
        processNarration:
          item.phase === "commentary" || (item.phase === undefined && index < lastTools[index]!),
      });
      index += 1;
      continue;
    }
    if (item.kind === "tool") {
      const tools: ToolTranscriptItem[] = [item];
      index += 1;
      while (index < items.length && items[index]?.kind === "tool") {
        tools.push(items[index] as ToolTranscriptItem);
        index += 1;
      }
      rows.push({
        kind: "activity",
        key: `activity:${tools[0]!.key}`,
        items: tools,
      });
      continue;
    }
    if (item.kind === "hosted_search") {
      const searches: Extract<TranscriptItem, { kind: "hosted_search" }>[] = [item];
      index += 1;
      while (index < items.length && items[index]?.kind === "hosted_search") {
        searches.push(items[index] as Extract<TranscriptItem, { kind: "hosted_search" }>);
        index += 1;
      }
      rows.push({
        kind: "hosted_search",
        key: `hosted-search-group:${searches[0]!.activityId}`,
        items: searches,
      });
      continue;
    }
    rows.push({ kind: "item", key: item.key, item });
    index += 1;
  }
  return rows;
}
