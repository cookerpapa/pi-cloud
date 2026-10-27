import {
  deriveConversationPresentationRows,
  type ConversationPresentationRow,
} from "./conversation-presentation.ts";
import { streamingMarkdownBlocks } from "./Markdown.tsx";
import type { TurnView, TranscriptItem } from "./session-view.ts";

export type VirtualConversationRow = {
  key: string;
  turn: TurnView;
  entryId?: string;
  cursor?: string;
  cursors?: readonly string[];
  fragment: {
    header: boolean;
    footer: boolean;
    rows: readonly ConversationPresentationRow[];
    copyText?: string;
  };
};
const splitCache = new WeakMap<object, readonly string[]>();
function textBlocks(item: Extract<TranscriptItem, { kind: "text" }>): readonly string[] {
  if (item.text.length < 16384) return [item.text];
  let blocks = splitCache.get(item);
  if (!blocks) {
    const nodes = streamingMarkdownBlocks(item.text);
    const grouped: string[] = [];
    let block = "";
    for (const node of nodes) {
      if (block.length >= 8192) {
        grouped.push(block);
        block = "";
      }
      block += node;
    }
    if (block) grouped.push(block);
    blocks = grouped;
    splitCache.set(item, blocks);
  }
  return blocks;
}
export function virtualConversationRows(
  turns: readonly TurnView[],
): readonly VirtualConversationRow[] {
  const result: VirtualConversationRow[] = [];
  for (const turn of turns) {
    if (turn.status === "queued" && !turn.operation) continue;
    if (turn.operation) {
      result.push({
        key: `${turn.turnId}:command`,
        turn,
        fragment: { header: true, footer: true, rows: [] },
      });
      continue;
    }
    if (!turn.continuesBefore && turn.prompt !== null)
      result.push({
        key: `${turn.turnId}:header`,
        turn,
        fragment: { header: true, footer: false, rows: [] },
        ...(turn.historyCursor ? { cursor: turn.historyCursor } : {}),
      });
    const rows = deriveConversationPresentationRows(
      turn.items.filter((i) => i.kind !== "compaction" || i.reason !== "manual"),
    );
    for (const row of rows) {
      const item =
        row.kind === "activity" || row.kind === "hosted_search" || row.kind === "retry"
          ? row.items[0]!
          : row.item;
      const entryId =
        item.kind === "text" || item.kind === "user"
          ? /^entry:([0-9]+)(?::|$)/.exec(item.messageId ?? "")?.[1]
          : undefined;
      const cursors = (
        row.kind === "activity" || row.kind === "hosted_search" || row.kind === "retry"
          ? row.items
          : [item]
      ).flatMap((i) => (i.historyCursor ? [i.historyCursor] : []));
      const base = {
        turn,
        cursors,
        ...(entryId ? { entryId } : {}),
        ...(item.historyCursor ? { cursor: item.historyCursor } : {}),
      };
      if (row.kind === "text") {
        const blocks = textBlocks(row.item);
        let offset = 0;
        blocks.forEach((text, index) => {
          result.push({
            ...base,
            key: `${turn.turnId}:${row.key}:${index}`,
            fragment: {
              header: false,
              footer: false,
              rows: [
                {
                  ...row,
                  item: {
                    ...row.item,
                    text,
                    recoveredTextLength: Math.min(
                      Math.max(0, (row.item.recoveredTextLength ?? 0) - offset),
                      text.length,
                    ),
                  },
                },
              ],
              ...(!row.processNarration && index === blocks.length - 1
                ? { copyText: row.item.text }
                : {}),
            },
          });
          offset += text.length;
        });
      } else
        result.push({
          ...base,
          key: `${turn.turnId}:${row.key}`,
          fragment: { header: false, footer: false, rows: [row] },
        });
    }
    if (!turn.continuesAfter)
      result.push({
        key: `${turn.turnId}:footer`,
        turn,
        fragment: { header: false, footer: true, rows: [] },
      });
  }
  return result;
}
