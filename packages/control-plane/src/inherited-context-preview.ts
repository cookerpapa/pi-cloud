import {
  MAX_INHERITED_CONTEXT_ENTRIES,
  MAX_INHERITED_CONTEXT_TEXT_CHARACTERS,
  MAX_INHERITED_CONTEXT_TOTAL_CHARACTERS,
  type ConversationDetailResource,
} from "@pi-cloud/protocol";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";

export type InheritedContextPreview = Pick<
  ConversationDetailResource,
  "inheritedMessages" | "inheritedContextSummary" | "inheritedMessagesTruncated"
>;
export type InheritedContextEntry = {
  id: string;
  type: string;
  timestampMs: string;
  payload: Record<string, unknown>;
};
type PreviewMessage = ConversationDetailResource["inheritedMessages"][number];

function timestamp(value: unknown): string {
  const date = new Date(Number(value));
  if (Number.isNaN(date.valueOf()))
    throw new ControlPlaneStoreError(
      "control_plane_misconfigured",
      "Inherited message timestamp is invalid",
    );
  return date.toISOString();
}

function visibleMessage(
  value: unknown,
  source: { entryId: string; createdAt: string; messageIndex?: number },
): PreviewMessage | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const message = value as Record<string, unknown>;
  if (message.role !== "user" && message.role !== "assistant") return;
  if (
    message.role === "assistant" &&
    (typeof message.stopReason !== "string" ||
      ["toolUse", "error", "aborted", "pending", "deferred"].includes(message.stopReason))
  )
    return;
  const text =
    typeof message.content === "string"
      ? message.content
      : Array.isArray(message.content)
        ? message.content
            .flatMap((part) =>
              typeof part === "object" &&
              part !== null &&
              part.type === "text" &&
              typeof part.text === "string"
                ? [part.text]
                : [],
            )
            .join("\n")
        : "";
  if (text.length === 0) return;
  return { ...source, role: message.role, text };
}

function clip(text: string, maximum: number): string {
  if (text.length <= maximum) return text;
  let end = maximum;
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--;
  return text.slice(0, end);
}

/** Rows are newest first, stopped at Compaction or one beyond the preview cap. */
export function inheritedContextPreview(
  rows: readonly InheritedContextEntry[],
): InheritedContextPreview {
  const window = rows.slice(0, MAX_INHERITED_CONTEXT_ENTRIES + 1);
  const compactionIndex = window.findIndex((row) => row.type === "compaction");
  const compaction = compactionIndex < 0 ? undefined : window[compactionIndex];
  const suffix = compactionIndex < 0 ? window : window.slice(0, compactionIndex);
  let truncated = compaction === undefined && rows.length > MAX_INHERITED_CONTEXT_ENTRIES;
  const messages: PreviewMessage[] = [];
  let summary: InheritedContextPreview["inheritedContextSummary"];
  let remaining = MAX_INHERITED_CONTEXT_TOTAL_CHARACTERS;
  if (compaction) {
    const { summary: text, retainedTail } = compaction.payload;
    if (typeof text !== "string" || !Array.isArray(retainedTail))
      throw new ControlPlaneStoreError(
        "control_plane_misconfigured",
        "Inherited Compaction is invalid",
      );
    const clipped = clip(text, MAX_INHERITED_CONTEXT_TEXT_CHARACTERS);
    truncated ||= clipped.length < text.length;
    remaining -= clipped.length;
    summary = {
      entryId: compaction.id,
      text: clipped,
      createdAt: timestamp(compaction.timestampMs),
    };
    const start = Math.max(0, retainedTail.length - MAX_INHERITED_CONTEXT_ENTRIES);
    truncated ||= start > 0;
    retainedTail.slice(start).forEach((message: unknown, index: number) => {
      const candidate = visibleMessage(message, {
        entryId: compaction.id,
        messageIndex: start + index,
        createdAt: timestamp(
          typeof message === "object" && message !== null && "timestamp" in message
            ? message.timestamp
            : compaction.timestampMs,
        ),
      });
      if (candidate) messages.push(candidate);
    });
  }
  for (const row of suffix.slice(0, MAX_INHERITED_CONTEXT_ENTRIES).reverse()) {
    if (row.type !== "message") continue;
    const message = visibleMessage(row.payload.message, {
      entryId: row.id,
      createdAt: timestamp(row.timestampMs),
    });
    if (message) messages.push(message);
  }
  truncated ||= messages.length > MAX_INHERITED_CONTEXT_ENTRIES;
  const preview: PreviewMessage[] = [];
  for (const message of messages.slice(-MAX_INHERITED_CONTEXT_ENTRIES).reverse()) {
    if (remaining === 0) {
      truncated = true;
      break;
    }
    const text = clip(message.text, Math.min(remaining, MAX_INHERITED_CONTEXT_TEXT_CHARACTERS));
    truncated ||= text.length < message.text.length;
    remaining -= text.length;
    if (text.length) preview.push({ ...message, text });
  }
  return {
    inheritedMessages: preview.reverse(),
    ...(summary ? { inheritedContextSummary: summary } : {}),
    ...(truncated ? { inheritedMessagesTruncated: true } : {}),
  };
}
