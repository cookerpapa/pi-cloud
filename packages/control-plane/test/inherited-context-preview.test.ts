import { describe, expect, it } from "vitest";
import {
  MAX_INHERITED_CONTEXT_ENTRIES,
  MAX_INHERITED_CONTEXT_TEXT_CHARACTERS,
  MAX_INHERITED_CONTEXT_TOTAL_CHARACTERS,
} from "@pi-cloud/protocol";
import {
  inheritedContextPreview,
  type InheritedContextEntry,
} from "../src/inherited-context-preview.ts";

function message(id: string, text = id): InheritedContextEntry {
  return {
    id,
    type: "message",
    timestampMs: "1",
    payload: {
      message: { role: "user", content: text, timestamp: 1 },
    },
  };
}
describe("inherited context preview", () => {
  it("does not restore pre-Compaction messages when the retained tail is empty", () => {
    const view = inheritedContextPreview([
      {
        id: "compact",
        type: "compaction",
        timestampMs: "1",
        payload: {
          summary: "Only a summary remains",
          retainedTail: [],
        },
      },
      message("old"),
    ]);
    expect(view.inheritedMessages).toEqual([]);
    expect(view.inheritedContextSummary?.text).toBe("Only a summary remains");
    expect(view.inheritedMessagesTruncated).toBeUndefined();
  });
  it("uses the latest native Compaction summary and its anonymous retained messages", () => {
    const compact: InheritedContextEntry = {
      id: "compact",
      type: "compaction",
      timestampMs: "2",
      payload: {
        summary: "Summarized history",
        retainedTail: [
          { role: "user", content: "Retained question", timestamp: 1 },
          {
            role: "assistant",
            content: [{ type: "text", text: "Retained answer" }],
            timestamp: 1,
            stopReason: "stop",
          },
        ],
      },
    };
    const view = inheritedContextPreview([message("new"), compact, message("old")]);
    expect(view.inheritedContextSummary).toMatchObject({
      entryId: "compact",
      text: "Summarized history",
    });
    expect(view.inheritedMessages).toMatchObject([
      { entryId: "compact", messageIndex: 0, text: "Retained question" },
      { entryId: "compact", messageIndex: 1, text: "Retained answer" },
      { entryId: "new", text: "new" },
    ]);
    expect(view.inheritedMessagesTruncated).toBeUndefined();
    expect(JSON.stringify(view)).not.toContain('"old"');
  });
  it("keeps a bounded recent preview when no Compaction is reachable", () => {
    const rows = Array.from({ length: MAX_INHERITED_CONTEXT_ENTRIES + 1 }, (_, n) =>
      message(String(n)),
    );
    const view = inheritedContextPreview(rows);
    expect(view.inheritedMessages).toHaveLength(MAX_INHERITED_CONTEXT_ENTRIES);
    expect(view.inheritedMessages[0]?.entryId).toBe(String(MAX_INHERITED_CONTEXT_ENTRIES - 1));
    expect(view.inheritedMessages.at(-1)?.entryId).toBe("0");
    expect(view.inheritedMessagesTruncated).toBe(true);
  });
  it("bounds combined text and never splits a surrogate pair", () => {
    const text = "x".repeat(MAX_INHERITED_CONTEXT_TEXT_CHARACTERS - 1) + "😀";
    const view = inheritedContextPreview(
      Array.from({ length: 10 }, (_, n) => message(String(n), text)),
    );
    expect(view.inheritedMessagesTruncated).toBe(true);
    expect(
      view.inheritedMessages.reduce((total, m) => total + m.text.length, 0),
    ).toBeLessThanOrEqual(MAX_INHERITED_CONTEXT_TOTAL_CHARACTERS);
    expect(view.inheritedMessages.every((m) => !/[\uD800-\uDFFF]/u.test(m.text))).toBe(true);
    expect(
      view.inheritedMessages.every((m) => m.text.length <= MAX_INHERITED_CONTEXT_TEXT_CHARACTERS),
    ).toBe(true);
  });
  it("bounds an embedded retained tail instead of expanding every old message", () => {
    const view = inheritedContextPreview([
      {
        id: "compact",
        type: "compaction",
        timestampMs: "1",
        payload: {
          summary: "Summary",
          retainedTail: Array.from({ length: 1000 }, (_, n) => ({
            role: "user",
            content: String(n),
            timestamp: 1,
          })),
        },
      },
    ]);
    expect(view.inheritedMessages).toHaveLength(MAX_INHERITED_CONTEXT_ENTRIES);
    expect(view.inheritedMessages.at(-1)).toMatchObject({
      entryId: "compact",
      messageIndex: 999,
      text: "999",
    });
    expect(view.inheritedMessagesTruncated).toBe(true);
  });
});
