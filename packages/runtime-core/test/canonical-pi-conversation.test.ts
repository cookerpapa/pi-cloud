import { expect, it } from "vitest";
import {
  projectDurableTranscript,
  type NativeHistoryRow,
} from "../src/canonical-pi-conversation.ts";
const at = new Date("2026-10-06T00:00:00Z");
const terminal = {
  throughSequence: 20,
  terminalSequence: 20,
  stopReason: "stop",
  failure: null,
  cancellation: null,
  occurredAt: at.toISOString(),
};
const row = (id: number, value: Record<string, unknown>, taskKind?: string): NativeHistoryRow => ({
  id: String(id),
  seq: String(id),
  body: JSON.stringify({ type: "entry", value: { id, conversationId: 1, ...value } }),
  fields: {},
  committed_at: at,
  ...(taskKind ? { task_kind: JSON.stringify(taskKind) } : {}),
});
const assistant = (content: unknown[], stopReason = "stop") => ({
  kind: "pi.assistant",
  model: [{ role: "assistant", content, stopReason, timestamp: at.valueOf() }],
});
const result = (callId: string, text: string, details?: unknown) => ({
  kind: "pi.tool-result",
  byTaskId: 4,
  model: [
    {
      role: "toolResult",
      toolCallId: callId,
      toolName: "bash",
      content: [{ type: "text", text }],
      timestamp: at.valueOf(),
      isError: false,
      ...(details ? { details } : {}),
    },
  ],
});

it("reconstructs native text phases, hosted search, compaction, retry and Tool details without a second transcript", () => {
  const entries = [
    row(
      2,
      assistant([
        {
          type: "text",
          text: "Working",
          textSignature: JSON.stringify({ v: 1, phase: "commentary" }),
        },
      ]),
    ),
    row(
      3,
      assistant([
        {
          type: "text",
          text: "",
          providerHostedTool: {
            toolName: "web_search",
            nativeItem: {
              id: "search",
              type: "web_search_call",
              status: "completed",
              action: { type: "search", queries: ["official docs"] },
            },
          },
        },
      ]),
    ),
    row(5, {
      kind: "pi.compaction",
      data: { reason: "overflow" },
      head: 2,
      model: [{ role: "user", content: "Summary not displayed", timestamp: at.valueOf() }],
    }),
    row(6, {
      state: { status: "running", checkpoint: { phase: "retry", attempt: 1, until: at.valueOf() } },
    }),
    row(
      7,
      assistant(
        [{ type: "toolCall", id: "call", name: "bash", arguments: { command: "one" } }],
        "toolUse",
      ),
    ),
    row(8, result("call", "OK", { previewPath: "/preview/3000" }), "pi.tool"),
    row(
      9,
      assistant([
        {
          type: "text",
          text: "Done",
          textSignature: JSON.stringify({ v: 1, phase: "final_answer" }),
        },
      ]),
    ),
  ];
  const view = projectDurableTranscript(entries, terminal);
  expect(view.items.map((item) => item.kind)).toEqual([
    "text",
    "hosted_search",
    "compaction",
    "retry",
    "tool",
    "text",
  ]);
  expect(view.items[3]).toMatchObject({ nextSamplingAttempt: 2 });
  expect(view.items[0]).toMatchObject({ phase: "commentary" });
  expect(view.items[4]).toMatchObject({
    toolCallId: "task:4",
    input: { command: "one" },
    status: "completed",
    output: { details: { previewPath: "/preview/3000" } },
  });
  expect(view.items[5]).toMatchObject({ phase: "final_answer" });
  expect(JSON.stringify(view)).not.toContain("Summary not displayed");
});

it("does not concatenate separate assistant messages or conflate reused provider call IDs", () => {
  const view = projectDurableTranscript(
    [
      row(
        2,
        assistant(
          [
            { type: "text", text: "one" },
            { type: "toolCall", id: "same", name: "bash", arguments: { command: "first" } },
          ],
          "toolUse",
        ),
      ),
      row(3, result("same", "first"), "pi.tool"),
      row(
        5,
        assistant(
          [
            { type: "text", text: "two" },
            { type: "toolCall", id: "same", name: "bash", arguments: { command: "second" } },
          ],
          "toolUse",
        ),
      ),
      row(6, { ...result("same", "second"), byTaskId: 7 }, "pi.tool"),
    ],
    terminal,
  );
  expect(
    view.items.filter((item) => item.kind === "tool").map((item) => [item.toolCallId, item.input]),
  ).toEqual([
    ["task:4", { command: "first" }],
    ["task:7", { command: "second" }],
  ]);
  expect(view.items.filter((item) => item.kind === "text").map((item) => item.text)).toEqual([
    "one",
    "two",
  ]);
});

it("keeps failed/aborted native text visible and gives unoffered calls their own entry identity", () => {
  const view = projectDurableTranscript(
    [
      row(2, assistant([{ type: "text", text: "Interrupted prefix" }], "aborted")),
      row(3, { ...result("unknown", "Not offered"), byTaskId: 2 }, "pi.generation"),
    ],
    {
      ...terminal,
      stopReason: null,
      failure: { code: "model_error", message: "Failed", retryable: false },
    },
  );
  expect(view.items[0]).toMatchObject({ text: "Interrupted prefix" });
  expect(view.items[1]).toMatchObject({ toolCallId: "entry:3" });
});

it("retains faulted Tool and aborted compaction receipts even when no native entry exists", () => {
  const view = projectDurableTranscript(
    [
      row(
        2,
        assistant(
          [{ type: "toolCall", id: "call", name: "bash", arguments: { command: "maybe" } }],
          "toolUse",
        ),
      ),
      row(3, {
        kind: "pi.tool",
        input: { assistant: 2, callId: "call" },
        state: {
          status: "terminal",
          outcome: { status: "faulted", error: { message: "internal transport detail" } },
        },
      }),
      row(4, {
        kind: "pi.compaction",
        input: { reason: "threshold" },
        state: { status: "terminal", outcome: { status: "aborted" } },
      }),
    ],
    terminal,
  );
  expect(view.items).toMatchObject([
    { kind: "tool", toolCallId: "task:3", status: "failed", input: { command: "maybe" } },
    { kind: "compaction", status: "aborted" },
  ]);
  expect(JSON.stringify(view)).not.toContain("internal transport detail");
});

it("projects a native execute checkpoint as a running Tool before its final entry exists", () => {
  const view = projectDurableTranscript(
    [
      row(
        2,
        assistant(
          [{ type: "toolCall", id: "call", name: "bash", arguments: { command: "original" } }],
          "toolUse",
        ),
      ),
      row(3, {
        kind: "pi.tool",
        input: { assistant: 2, callId: "call" },
        state: {
          status: "running",
          checkpoint: { phase: "execute", arguments: { command: "validated" } },
        },
      }),
    ],
    { ...terminal, terminalSequence: null },
  );
  expect(view.items).toEqual([
    expect.objectContaining({
      kind: "tool",
      toolCallId: "task:3",
      toolName: "bash",
      input: { command: "validated" },
      status: "running",
    }),
  ]);
  expect(view.items[0]).not.toHaveProperty("completedAt");
});
