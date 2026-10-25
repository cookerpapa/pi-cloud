import type {
  ConversationDetailResource,
  ConversationTurnResource,
  ConversationTranscriptItemResource,
} from "@pi-cloud/protocol";

function json(value: unknown): string {
  return JSON.stringify(value, null, 2) ?? "null";
}
function code(language: string, value: string): string {
  let length = 3;
  for (const match of value.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  const fence = "`".repeat(length);
  return `${fence}${language}\n${value}\n${fence}`;
}
export function conversationExportFilename(title: string, at: Date): string {
  return `${
    title
      .normalize("NFKC")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80) || "conversation"
  }-${at.toISOString().replace(/[:.]/g, "-")}.md`;
}
export function conversationMarkdownHeader(view: ConversationDetailResource, at: Date): string {
  const lines = [
    "---",
    'schema: "pi-cloud.session-export.v2"',
    `sessionId: ${JSON.stringify(view.session.sessionId)}`,
    `title: ${JSON.stringify(view.session.title)}`,
    `exportedAt: ${JSON.stringify(at.toISOString())}`,
    "historyTruncated: false",
    "---",
    "",
    `# ${view.session.title}`,
    "",
  ];
  if (
    view.inheritedMessages.length ||
    view.inheritedContextSummary ||
    view.inheritedMessagesTruncated
  ) {
    lines.push("## Inherited context preview", "");
    if (view.inheritedContextSummary)
      lines.push("### Context summary", "", view.inheritedContextSummary.text, "");
    if (view.inheritedMessagesTruncated)
      lines.push(
        "Only part of the inherited context is included; see the parent conversation for full history.",
        "",
      );
    for (const item of view.inheritedMessages)
      lines.push(`### ${item.role === "user" ? "User" : "Assistant"}`, "", item.text, "");
  }
  return lines.join("\n") + "\n";
}
export function conversationMarkdownItem(item: ConversationTranscriptItemResource): string {
  if (item.kind === "text") return item.text + "\n\n";
  if (item.kind === "user")
    return `### User\n\n${item.text}\n${item.uploads?.map((u) => `- ${u.name} (${u.path})`).join("\n") ?? ""}\n### Assistant\n\n`;
  if (item.kind === "tool_preparing") return "";
  if (item.kind === "tool")
    return `<details>\n<summary>Tool · ${item.toolName} · ${item.status}</summary>\n\n**Input**\n\n${code("json", json(item.input))}${item.output === undefined ? "" : `\n\n**Output**\n\n${code("json", json(item.output))}`}\n\n</details>\n\n`;
  if (item.kind === "notification") return `> ${item.level.toUpperCase()}: ${item.message}\n\n`;
  if (item.kind === "compaction") return `> Context compaction: ${item.status}\n\n`;
  if (item.kind === "retry") return `> Model retry: attempt ${item.nextSamplingAttempt}\n\n`;
  const detail =
    item.action?.type === "search"
      ? item.action.queries.join("; ")
      : item.action?.type === "open_page"
        ? item.action.url
        : item.action?.type === "find_in_page"
          ? [item.action.pattern, item.action.url].filter(Boolean).join(" · ")
          : "";
  return `> Web search: ${item.status}${detail ? " — " + detail : ""}\n\n`;
}
export function conversationMarkdownTurnHeader(
  turn: ConversationTurnResource,
  index: number,
): string {
  if (turn.operation) return `## Context compaction\n\n> /compact · ${turn.operation.state}\n\n`;
  return `## Turn ${index}\n\n### User\n\n${turn.prompt}\n\n${turn.uploads?.length ? `**Attachments**\n\n${code("json", json(turn.uploads.map(({ name, path, mimeType, byteLength }) => ({ name, path, mimeType, byteLength }))))}\n\n` : ""}### Assistant\n\n`;
}
export function conversationMarkdownTurnEnd(turn: ConversationTurnResource): string {
  const transcript = turn.transcript;
  if (transcript?.failure)
    return `> Turn failed: ${transcript.failure.code} — ${transcript.failure.message}\n\n`;
  if (transcript?.cancellation) return `> Turn cancelled: ${transcript.cancellation.reason}\n\n`;
  return "";
}
/** The writer holds only the current page/Turn identity, never all export text. */
export async function* conversationMarkdown(
  pages: AsyncIterable<ConversationDetailResource>,
  at = new Date(),
): AsyncGenerator<string> {
  let opened = false,
    lastTurn: string | undefined,
    index = 0;
  for await (const page of pages) {
    if (!opened) {
      yield conversationMarkdownHeader(page, at);
      opened = true;
    }
    for (const turn of page.turns) {
      if (!["completed", "failed", "cancelled"].includes(turn.state)) continue;
      if (lastTurn !== turn.turnId) {
        if (!turn.operation) index++;
        yield conversationMarkdownTurnHeader(turn, index);
        lastTurn = turn.turnId;
      }
      if (!turn.operation)
        for (const item of turn.transcript?.items ?? []) yield conversationMarkdownItem(item);
      if (!turn.continuesAfter) yield conversationMarkdownTurnEnd(turn);
    }
  }
}
