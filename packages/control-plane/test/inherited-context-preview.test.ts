import { expect, it } from "vitest";
import {
  MAX_INHERITED_CONTEXT_ENTRIES,
  MAX_INHERITED_CONTEXT_TEXT_CHARACTERS,
  MAX_INHERITED_CONTEXT_TOTAL_CHARACTERS,
} from "@pi-cloud/protocol";
import {
  inheritedContextPreview,
  type InheritedContextEntry,
} from "../src/inherited-context-preview.ts";
function entry(id: number, text = String(id), kind = "pi.user"): InheritedContextEntry {
  return {
    entry: { id, conversationId: 1, kind, model: [{ role: "user", content: text, timestamp: 1 }] },
    turnId: null,
    runId: null,
    sessionId: null,
    seq: id,
    createdAt: new Date(1).toISOString(),
  } as InheritedContextEntry;
}
it("shows the native summary and retained entry identities supplied by the bounded head reader", () => {
  const preview = inheritedContextPreview([
    entry(5, "new"),
    entry(4, "Summary", "pi.compaction"),
    entry(3, "Retained question"),
  ]);
  expect(preview.inheritedContextSummary).toMatchObject({ entryId: "4", text: "Summary" });
  expect(preview.inheritedMessages).toMatchObject([
    { entryId: "3", messageIndex: 0, text: "Retained question" },
    { entryId: "5", text: "new" },
  ]);
  expect(preview.inheritedMessagesTruncated).toBeUndefined();
});
it("does not invent retained messages when only a summary remains", () => {
  const preview = inheritedContextPreview([entry(4, "Only summary", "pi.compaction")]);
  expect(preview.inheritedMessages).toEqual([]);
  expect(preview.inheritedContextSummary?.text).toBe("Only summary");
});
it("bounds the newest entries and total text without splitting surrogate pairs", () => {
  const text = "x".repeat(MAX_INHERITED_CONTEXT_TEXT_CHARACTERS - 1) + "😀";
  const preview = inheritedContextPreview(
    Array.from({ length: 1000 }, (_, index) => entry(index + 1, text)),
  );
  expect(preview.inheritedMessagesTruncated).toBe(true);
  expect(preview.inheritedMessages.length).toBeLessThanOrEqual(MAX_INHERITED_CONTEXT_ENTRIES);
  expect(
    preview.inheritedMessages.reduce((n, message) => n + message.text.length, 0),
  ).toBeLessThanOrEqual(MAX_INHERITED_CONTEXT_TOTAL_CHARACTERS);
  expect(preview.inheritedMessages.every((message) => !/[\uD800-\uDFFF]/u.test(message.text))).toBe(
    true,
  );
});
