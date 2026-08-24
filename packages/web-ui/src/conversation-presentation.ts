import type { TranscriptItem } from "./session-view.ts";
import type { ToolTranscriptItem } from "./ToolActivity.tsx";

export type ConversationPresentationRow =
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
  const lastToolIndex = items.reduce(
    (lastIndex, item, index) => (item.kind === "tool" ? index : lastIndex),
    -1,
  );
  const rows: ConversationPresentationRow[] = [];
  let index = 0;
  while (index < items.length) {
    const item = items[index]!;
    if (item.kind === "text") {
      rows.push({
        kind: "text",
        key: item.key,
        item,
        processNarration: index < lastToolIndex,
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
    rows.push({ kind: "item", key: item.key, item });
    index += 1;
  }
  return rows;
}
