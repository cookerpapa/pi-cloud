import { describe, expect, it } from "vitest";
import { deriveConversationPresentationRows } from "../src/conversation-presentation.ts";
import type { TranscriptItem } from "../src/session-view.ts";

function tool(key: string, sequence: number): Extract<TranscriptItem, { kind: "tool" }> {
  return {
    kind: "tool",
    key,
    toolCallId: key,
    toolName: key.includes("bash") ? "bash" : "read",
    input: {},
    status: "completed",
    firstSequence: sequence,
    lastSequence: sequence,
    startedAt: "2026-08-24T00:00:00.000Z",
    completedAt: "2026-08-24T00:00:00.100Z",
  };
}

describe("conversation presentation rows", () => {
  it("groups only adjacent Tools and preserves every durable key", () => {
    const items: TranscriptItem[] = [
      {
        kind: "text",
        key: "text:1",
        text: "Inspecting.",
        firstSequence: 1,
        lastSequence: 1,
      },
      tool("read:2", 2),
      tool("bash:3", 3),
      {
        kind: "text",
        key: "text:4",
        text: "Done.",
        firstSequence: 4,
        lastSequence: 4,
      },
    ];
    const rows = deriveConversationPresentationRows(items);
    expect(rows).toMatchObject([
      { kind: "text", key: "text:1", processNarration: true },
      { kind: "activity", key: "activity:read:2", items: [{ key: "read:2" }, { key: "bash:3" }] },
      { kind: "text", key: "text:4", processNarration: false },
    ]);
  });

  it("keeps lifecycle boundaries outside Tool groups", () => {
    const rows = deriveConversationPresentationRows([
      tool("read:1", 1),
      {
        kind: "compaction",
        key: "compaction:2",
        reason: "threshold",
        status: "completed",
        willRetry: false,
        firstSequence: 2,
        lastSequence: 3,
      },
      tool("bash:4", 4),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["activity", "item", "activity"]);
  });
});
