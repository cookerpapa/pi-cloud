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
  it("updates one retry row across live and historical page boundaries without losing source items", () => {
    const items: TranscriptItem[] = [2, 3, 4].map((attempt) => ({
      kind: "retry",
      key: `retry:${attempt}`,
      sequence: attempt,
      nextSamplingAttempt: attempt,
      historyCursor: `cursor:${attempt}`,
      pageKey: attempt === 2 ? "snapshot" : "later",
    }));
    for (let length = 1; length <= items.length; length++) {
      const rows = deriveConversationPresentationRows(items.slice(0, length));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        kind: "retry",
        key: "retry:2",
        items: items.slice(0, length),
      });
    }
    expect(items.map((item) => item.key)).toEqual(["retry:2", "retry:3", "retry:4"]);
  });
  it("starts a fresh notice after a retry counter reset or intervening work", () => {
    const retry = (attempt: number, sequence: number): TranscriptItem => ({
      kind: "retry",
      key: `retry:${sequence}`,
      sequence,
      nextSamplingAttempt: attempt,
    });
    const rows = deriveConversationPresentationRows([
      retry(2, 1),
      retry(3, 2),
      retry(2, 3),
      tool("read:4", 4),
      retry(2, 5),
      retry(3, 6),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["retry", "retry", "activity", "retry"]);
    expect(
      rows
        .filter((row) => row.kind === "retry")
        .map((row) => row.items.at(-1)!.nextSamplingAttempt),
    ).toEqual([3, 2, 3]);
  });
  it("keeps real page boundaries and bounded groups while live items continue their page", () => {
    const rows = deriveConversationPresentationRows(
      Array.from({ length: 15 }, (_, index) => ({
        ...tool(`bash:${index}`, index),
        pageKey: index === 0 ? "older" : "latest",
      })),
    );
    expect(rows.map((row) => (row.kind === "activity" ? row.items.length : 0))).toEqual([1, 12, 2]);
  });
  it("uses explicit phase before a Tool exists and does not reclassify an explicit final answer", () => {
    expect(
      deriveConversationPresentationRows([
        {
          kind: "text",
          key: "a",
          text: "Working.",
          phase: "commentary",
          firstSequence: 1,
          lastSequence: 1,
        },
        {
          kind: "text",
          key: "b",
          text: "Answer.",
          phase: "final_answer",
          firstSequence: 2,
          lastSequence: 2,
        },
        tool("bash", 3),
      ]),
    ).toMatchObject([
      { kind: "text", processNarration: true },
      { kind: "text", processNarration: false },
      { kind: "activity" },
    ]);
  });
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

it("keeps successive human inputs between answers without reclassifying earlier answers", () => {
  const rows = deriveConversationPresentationRows([
    { kind: "text", key: "first", text: "First answer", firstSequence: 1, lastSequence: 1 },
    {
      kind: "user",
      key: "user:second",
      messageId: "entry:23",
      inputId: "second",
      text: "Now inspect files",
      firstSequence: 2,
      lastSequence: 2,
    },
    tool("read:3", 3),
    { kind: "text", key: "second", text: "Second answer", firstSequence: 4, lastSequence: 4 },
  ]);
  expect(rows).toMatchObject([
    { kind: "text", processNarration: false },
    { kind: "user", item: { text: "Now inspect files" } },
    { kind: "activity" },
    { kind: "text", processNarration: false },
  ]);
});
