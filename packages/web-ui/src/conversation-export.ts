import type {
  ConversationDetailResource,
  ConversationTranscriptItemResource,
} from "@pi-cloud/protocol";

const TERMINAL_TURN_STATES = new Set(["completed", "failed", "cancelled"]);

function json(value: unknown): string {
  const rendered = JSON.stringify(value, null, 2);
  return rendered === undefined ? "null" : rendered;
}

function codeBlock(language: string, value: string): string {
  const longest = Math.max(3, ...[...value.matchAll(/`+/g)].map((match) => match[0].length + 1));
  const fence = "`".repeat(longest);
  return `${fence}${language}\n${value}\n${fence}`;
}

function toolMarkdown(item: Extract<ConversationTranscriptItemResource, { kind: "tool" }>): string {
  const sections = [
    `<details>`,
    `<summary>Tool · ${item.toolName} · ${item.status}</summary>`,
    "",
    "**Input**",
    "",
    codeBlock("json", json(item.input)),
  ];
  if (item.output !== undefined) {
    sections.push("", "**Output**", "", codeBlock("json", json(item.output)));
  }
  sections.push("", "</details>");
  return sections.join("\n");
}

function transcriptItemMarkdown(item: ConversationTranscriptItemResource): string {
  if (item.kind === "text") return item.text;
  if (item.kind === "tool") return toolMarkdown(item);
  if (item.kind === "notification") return `> ${item.level.toUpperCase()}: ${item.message}`;
  if (item.kind === "approval") {
    return `> Approval: ${item.approval.title} · ${item.outcome ?? "pending"}`;
  }
  if (item.kind === "compaction") {
    const tokens = item.tokensBefore === undefined ? "" : ` · ${String(item.tokensBefore)} tokens`;
    return `> Context compaction: ${item.status}${tokens}`;
  }
  return `> Model retry: attempt ${String(item.nextSamplingAttempt)}${item.maximumSamplingAttempts === undefined ? "" : `/${String(item.maximumSamplingAttempts)}`}`;
}

export function conversationExportMarkdown(
  conversation: ConversationDetailResource,
  exportedAt: Date,
): string {
  if (Number.isNaN(exportedAt.valueOf())) throw new TypeError("Export timestamp is invalid");
  const lines = [
    "---",
    'schema: "pi-cloud.session-export.v1"',
    `sessionId: ${JSON.stringify(conversation.session.sessionId)}`,
    `title: ${JSON.stringify(conversation.session.title)}`,
    `exportedAt: ${JSON.stringify(exportedAt.toISOString())}`,
    `historyTruncated: ${String(conversation.historyTruncated)}`,
    "---",
    "",
    `# ${conversation.session.title}`,
    "",
  ];

  if (conversation.inheritedMessages.length > 0) {
    lines.push("## Inherited history", "");
    for (const message of conversation.inheritedMessages) {
      lines.push(`### ${message.role === "user" ? "User" : "Assistant"}`, "", message.text, "");
    }
  }

  const turns = conversation.turns.filter((turn) => TERMINAL_TURN_STATES.has(turn.state));
  turns.forEach((turn, index) => {
    lines.push(`## Turn ${String(index + 1)}`, "", "### User", "", turn.prompt, "");
    if (turn.transcript !== undefined) {
      lines.push("### Assistant", "");
      for (const item of turn.transcript.items) {
        lines.push(transcriptItemMarkdown(item), "");
      }
      if (turn.transcript.failure !== null) {
        lines.push(
          `> Turn failed: ${turn.transcript.failure.code} — ${turn.transcript.failure.message}`,
          "",
        );
      }
      if (turn.transcript.cancellation !== null) {
        lines.push(`> Turn cancelled: ${turn.transcript.cancellation.reason}`, "");
      }
    }
  });

  if (conversation.historyTruncated) {
    lines.push("> Earlier history was truncated by the canonical conversation boundary.", "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function conversationExportFilename(title: string, exportedAt: Date): string {
  if (Number.isNaN(exportedAt.valueOf())) throw new TypeError("Export timestamp is invalid");
  const safeTitle = title
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const date = exportedAt.toISOString().replace(/[:.]/g, "-");
  return `${safeTitle || "conversation"}-${date}.md`;
}

export function downloadConversationMarkdown(filename: string, markdown: string): void {
  const url = URL.createObjectURL(new Blob([markdown], { type: "text/markdown;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
