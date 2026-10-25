import { describe, it, expect } from "vitest";
import {
  HISTORY_BROWSER_PAGES,
  HISTORY_LIVE_CHARACTERS,
  HISTORY_LIVE_ITEMS,
  type PiCloudEvent,
} from "@pi-cloud/protocol";
import {
  appendHistoryPage,
  mergeHistoryPages,
  observeHistoryPages,
  freezeHistoryView,
  type HistoryPage,
} from "../src/history-window.ts";
import {
  createInitialSessionView,
  sessionViewReducer,
  type TurnView,
  presentationItemCharacters,
} from "../src/session-view.ts";
import { virtualConversationRows } from "../src/virtual-conversation-rows.ts";

const turnId = "20000000-0000-4000-8000-000000000001";
const sessionId = "10000000-0000-4000-8000-000000000001";
function turn(index: number): TurnView {
  return {
    turnId,
    runId: "30000000-0000-4000-8000-000000000001",
    mailboxPosition: 1,
    prompt: null,
    acceptedAt: null,
    status: "running",
    items: [
      {
        kind: "text",
        key: "text-" + index,
        messageId: `entry:${index + 1}:0`,
        text: `${index}:` + "x".repeat(16384),
        firstSequence: index + 1,
        lastSequence: index + 1,
        pageKey: "page-" + index,
      },
    ],
    continuesBefore: true,
    startedSequence: 1,
    terminalSequence: null,
    stopReason: null,
    failure: null,
    cancellation: null,
  };
}
function page(index: number): HistoryPage {
  return {
    turns: [turn(index)],
    history: {
      before: "before-" + index,
      after: "after-" + index,
      hasBefore: true,
      hasAfter: true,
    },
  };
}

describe("conversation read windows", () => {
  it("evicts the far side during sustained browsing while preserving order and content", () => {
    let pages: readonly HistoryPage[] = [];
    for (let i = 1000; i >= 0; i--) pages = appendHistoryPage(pages, page(i), "before");
    expect(pages).toHaveLength(HISTORY_BROWSER_PAGES);
    expect(
      mergeHistoryPages(pages)[0]?.items.map((i) => i.kind === "text" && i.text.split(":")[0]),
    ).toEqual(["0", "1", "2", "3"]);
    for (let i = 4; i <= 1000; i++) pages = appendHistoryPage(pages, page(i), "after");
    expect(
      mergeHistoryPages(pages)[0]?.items.map((i) => i.kind === "text" && i.text.split(":")[0]),
    ).toEqual(["997", "998", "999", "1000"]);
  });
  it("reconciles a settled streaming message with a canonical page without duplicate text or remount identity", () => {
    const old = page(0);
    const first = old.turns[0]!;
    const original = first.items[0]!;
    const frozen = [
      { ...old, turns: [{ ...first, items: [{ ...original, messageId: "live:doc:0" }] }] },
    ] as HistoryPage[];
    const renamed = observeHistoryPages(frozen, {
      type: "assistant.text.delta",
      turnId,
      payload: { messageId: "live:doc:0", settledMessageId: "entry:1:0", text: "" },
    } as PiCloudEvent);
    const canonical = page(0);
    canonical.turns[0]!.items[0]!.key = "canonical-key";
    const merged = mergeHistoryPages([...renamed, canonical]);
    expect(merged[0]?.items).toHaveLength(1);
    expect(merged[0]?.items[0]?.key).toBe(original.key);
  });
  it("bounds a continuously growing live Run and remembers a precise look-back anchor", () => {
    let state = createInitialSessionView();
    for (let i = 0; i < 3000; i++)
      state = sessionViewReducer(state, {
        type: "stream.event",
        event: {
          schemaVersion: 1,
          eventId: "40000000-0000-4000-8000-000000000001",
          sessionId,
          turnId,
          agentId: "root",
          occurredAt: "2026-10-26T00:00:00.000Z",
          seq: i + 1,
          type: "assistant.text.delta",
          payload: { text: "message-" + i + "x".repeat(8192), messageId: `entry:${i + 1}:0` },
        },
      });
    const items = state.turns.flatMap((t) => t.items);
    expect(items.length).toBeLessThanOrEqual(HISTORY_LIVE_ITEMS);
    expect(items.reduce((n, i) => n + presentationItemCharacters(i), 0)).toBeLessThanOrEqual(
      HISTORY_LIVE_CHARACTERS,
    );
    expect(items.at(-1)).toMatchObject({ text: expect.stringContaining("message-2999") });
    expect(state.historyAnchor).toMatchObject({ turnId, entryId: expect.any(String) });
    expect(freezeHistoryView(state).beforeQuery).toEqual(state.historyAnchor);
  });
  it("creates bounded virtual rows inside one Run", () => {
    const base = turn(0),
      tools = Array.from({ length: 1200 }, (_, i) => ({
        kind: "tool" as const,
        key: "tool-" + i,
        toolCallId: `task:${i + 2}`,
        toolName: "bash",
        input: { command: "pwd" },
        status: "completed" as const,
        firstSequence: i + 1,
        startedAt: "2026-10-26T00:00:00.000Z",
        pageKey: "page-" + Math.floor(i / 64),
      }));
    const rows = virtualConversationRows([{ ...base, items: tools }]);
    expect(rows.length).toBeGreaterThan(100);
    expect(
      rows
        .filter((r) => r.fragment.rows[0]?.kind === "activity")
        .every(
          (r) => r.fragment.rows[0]?.kind === "activity" && r.fragment.rows[0].items.length <= 12,
        ),
    ).toBe(true);
  });
  it("keeps an active Tool while evicting settled output and uses its Task for look-back", () => {
    const pending = {
      kind: "tool" as const,
      key: "pending",
      toolCallId: "task:2",
      toolName: "bash",
      input: { command: "long task" },
      status: "running" as const,
      firstSequence: 1,
      startedAt: "2026-10-26T00:00:00.000Z",
    };
    let state = { ...createInitialSessionView(), turns: [{ ...turn(0), items: [pending] }] };
    for (let i = 0; i < 300; i++)
      state = sessionViewReducer(state, {
        type: "stream.event",
        event: {
          schemaVersion: 1,
          eventId: "40000000-0000-4000-8000-000000000001",
          sessionId,
          turnId,
          agentId: "root",
          occurredAt: "2026-10-26T00:00:00.000Z",
          seq: i + 2,
          type: "assistant.text.delta",
          payload: { text: "x".repeat(16384), messageId: `entry:${i + 3}:0` },
        },
      }) as typeof state;
    expect(state.turns[0]?.items[0]).toEqual(pending);
    expect(freezeHistoryView(state).beforeQuery).toEqual({ turnId, toolCallId: "task:2" });
  });
});
