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
  refreshReadingState,
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
  it.each([
    ["compact_no_op", "no_op"],
    ["compact_stale", "stale"],
    ["stop", "applied"],
  ] as const)("updates a frozen manual compaction outcome %s", (stopReason, state) => {
    const running: TurnView = { ...turn(0), operation: { kind: "compact", state: "summarizing" } };
    const frozen = freezeHistoryView({ ...createInitialSessionView(), turns: [running] });
    const updated = observeHistoryPages([frozen], {
      type: "turn.completed",
      turnId,
      seq: 20,
      payload: { stopReason },
    } as PiCloudEvent);
    expect(updated[0]!.turns[0]!.operation?.state).toBe(state);
    expect(updated[0]!.turns[0]!.items).toBe(frozen.turns[0]!.items);
  });
  it.each(["completed", "failed", "cancelled"] as const)(
    "keeps %s truthful without completing frozen text or its copy",
    (status) => {
      const text = turn(0).items[0]!;
      if (text.kind !== "text") throw new Error("Expected text fixture");
      const running: TurnView = {
        ...turn(0),
        items: [
          {
            ...text,
            kind: "text" as const,
            messageId: "live:doc:0",
            text: "Partial answer",
          },
        ],
      };
      const frozen = freezeHistoryView({ ...createInitialSessionView(), turns: [running] });
      const payload =
        status === "completed"
          ? { stopReason: "stop" }
          : status === "failed"
            ? { code: "model_request_failed", message: "connection failed", retryable: true }
            : { reason: "user_stop", forced: false };
      const event = { type: `turn.${status}`, turnId, seq: 20, payload } as PiCloudEvent;
      const observed = observeHistoryPages([frozen], event);
      expect(observed[0]!.turns[0]!.status).toBe(status);
      expect(observed[0]!.turns[0]!.items).toBe(frozen.turns[0]!.items);
      expect(observed[0]!.turns[0]!.items[0]).toMatchObject({
        text: "Partial answer",
        frozenStreaming: true,
      });
      expect(
        virtualConversationRows(observed[0]!.turns).some(
          (row) => row.fragment.copyText !== undefined,
        ),
      ).toBe(false);
      const latest = {
        ...observed[0]!.turns[0]!,
        items: [{ ...text, messageId: "entry:5:0", text: "Partial answer, now complete" }],
      };
      const fromSnapshot = refreshReadingState([frozen], [latest], false);
      expect(fromSnapshot[0]!.turns[0]!.status).toBe(status);
      expect(fromSnapshot[0]!.turns[0]!.items).toBe(frozen.turns[0]!.items);
      const identified = observeHistoryPages(observed, {
        type: "assistant.text.delta",
        turnId,
        seq: 19,
        payload: { messageId: "live:doc:0", settledMessageId: "entry:5:0", text: "" },
      } as PiCloudEvent);
      const canonical = mergeHistoryPages([...identified, { ...frozen, turns: [latest] }]);
      expect(canonical[0]!.items[0]).not.toHaveProperty("frozenStreaming");
      expect(
        virtualConversationRows(canonical).some((row) => row.fragment.copyText !== undefined),
      ).toBe(true);
      expect(
        observeHistoryPages(observed, {
          ...event,
          seq: 10,
          payload: { stopReason: "stop" },
          type: "turn.completed",
        } as PiCloudEvent)[0]!.turns[0]!.status,
      ).toBe(status);
    },
  );
  it("keeps the reading window across live trimming while settling only known Tools", () => {
    const base = turn(0),
      text = base.items[0]!;
    const tool = {
      kind: "tool" as const,
      key: "original",
      toolCallId: "task:1",
      toolName: "bash",
      input: { command: "echo ready" },
      status: "running" as const,
      firstSequence: 2,
      startedAt: "2026-10-31T00:00:00Z",
      pageKey: "page-a",
      historyCursor: "old-cursor",
    };
    const pages = [{ ...page(0), turns: [{ ...base, items: [text, tool] }] }];
    const completed = {
      ...tool,
      key: "other-key",
      toolName: "unknown",
      input: null,
      status: "completed" as const,
      lastSequence: 9,
      output: { content: [{ type: "text", text: "finished" }] },
      pageKey: "live",
      historyCursor: "live-cursor",
    };
    const live = [
      { ...base, items: [completed, { ...completed, key: "new", toolCallId: "task:2" }] },
    ];
    const updated = refreshReadingState(pages, live);
    expect(updated[0]!.turns[0]!.items).toHaveLength(2);
    expect(updated[0]!.turns[0]!.items[0]).toBe(text);
    expect(updated[0]!.turns[0]!.items[1]).toMatchObject({
      key: "original",
      toolName: "bash",
      input: tool.input,
      status: "completed",
      output: completed.output,
      pageKey: "page-a",
      historyCursor: "old-cursor",
    });
    expect(refreshReadingState(updated, live)).toBe(updated);
    expect(refreshReadingState(updated, [{ ...base, items: [tool] }])).toBe(updated);
  });
  it("copies the complete final answer from the footer even when its text spans virtual rows", () => {
    const finalText = ("Long answer paragraph. ".repeat(400) + "\n\n").repeat(3);
    const base = turn(0);
    const first = { ...base.items[0]!, text: "Earlier answer" };
    const answer = { ...first, key: "final-answer", text: finalText };
    const rows = virtualConversationRows([
      { ...base, status: "completed", items: [first, answer] },
    ]);
    expect(rows.filter((row) => row.key.includes(":final-answer:")).length).toBeGreaterThan(1);
    expect(rows.at(-1)?.fragment).toMatchObject({ footer: true, copyText: finalText });
    expect(rows.filter((row) => row.fragment.copyText !== undefined)).toHaveLength(2);
    expect(rows.find((row) => row.fragment.copyText === "Earlier answer")?.fragment.footer).toBe(
      false,
    );
    expect(rows.filter((row) => row.fragment.copyText === finalText)).toHaveLength(1);
  });
  it("keeps every retry cursor addressable in one virtual row", () => {
    const item = (attempt: number) => ({
      kind: "retry" as const,
      key: `retry:${attempt}`,
      sequence: attempt,
      nextSamplingAttempt: attempt,
      historyCursor: `retry-cursor:${attempt}`,
      pageKey: `page:${attempt}`,
    });
    const rows = virtualConversationRows([
      { ...turn(0), continuesAfter: true, items: [item(2), item(3), item(4)] },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: `${turnId}:retry:2`,
      cursor: "retry-cursor:2",
      cursors: ["retry-cursor:2", "retry-cursor:3", "retry-cursor:4"],
    });
  });
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
