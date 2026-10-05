import {
  MAX_INHERITED_CONTEXT_ENTRIES,
  MAX_INHERITED_CONTEXT_TEXT_CHARACTERS,
  MAX_INHERITED_CONTEXT_TOTAL_CHARACTERS,
  type ConversationDetailResource,
} from "@pi-cloud/protocol";

export type InheritedContextPreview = Pick<
  ConversationDetailResource,
  "inheritedMessages" | "inheritedContextSummary" | "inheritedMessagesTruncated"
>;
export type InheritedContextEntry =
  import("@pi-cloud/pi-session-postgres/durable").StoredHistoryEntry;
type PreviewMessage = ConversationDetailResource["inheritedMessages"][number];

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

/** Native head selection has already bounded this newest-first preview. */
export function inheritedContextPreview(
  rows: readonly InheritedContextEntry[],
): InheritedContextPreview {
  const window = rows.slice(0, MAX_INHERITED_CONTEXT_ENTRIES);
  const compaction = window.find((row) => row.entry.kind === "pi.compaction");
  const messages: PreviewMessage[] = [];
  let truncated = rows.length > MAX_INHERITED_CONTEXT_ENTRIES;
  let summary: InheritedContextPreview["inheritedContextSummary"];
  let remaining = MAX_INHERITED_CONTEXT_TOTAL_CHARACTERS;
  if (compaction) {
    const model = compaction.entry.model?.find((message) => message.role === "user");
    const text =
      typeof model?.content === "string"
        ? model.content
        : (model?.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n") ??
          "");
    const clipped = clip(text, MAX_INHERITED_CONTEXT_TEXT_CHARACTERS);
    truncated ||= clipped.length < text.length;
    remaining -= clipped.length;
    summary = {
      entryId: String(compaction.entry.id),
      text: clipped,
      createdAt: compaction.createdAt,
    };
  }
  for (const row of window) {
    if (row === compaction) continue;
    for (const [index, message] of (row.entry.model ?? []).entries()) {
      const value = visibleMessage(message, {
        entryId: String(row.entry.id),
        createdAt: row.createdAt,
        messageIndex: index,
      });
      if (!value) continue;
      if (!remaining) {
        truncated = true;
        break;
      }
      const text = clip(value.text, Math.min(remaining, MAX_INHERITED_CONTEXT_TEXT_CHARACTERS));
      truncated ||= text.length < value.text.length;
      remaining -= text.length;
      messages.push({ ...value, text });
    }
  }
  return {
    inheritedMessages: messages.reverse(),
    ...(summary ? { inheritedContextSummary: summary } : {}),
    ...(truncated ? { inheritedMessagesTruncated: true } : {}),
  };
}
