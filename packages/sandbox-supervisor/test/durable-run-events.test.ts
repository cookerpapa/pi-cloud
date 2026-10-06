import { expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AgentEvent, SnapshotEvent, TaskRecord } from "@earendil-works/pi-durable";
import type { PiCloudEventBody } from "@pi-cloud/protocol";
import { DurableRunEvents } from "../src/durable/run-events.ts";
function fixture(outcome = "completed", maximum = 65536) {
  const bodies: PiCloudEventBody[] = [];
  const events = new DurableRunEvents({
    writerId: "writer",
    emit: async (body) => {
      bodies.push(body);
    },
    toolId: () => "task:3",
    maximumToolOutputBytes: maximum,
    retryAttempts: 4,
    task: async () =>
      ({ state: { status: "terminal", outcome: { status: outcome } } }) as TaskRecord<
        never,
        never,
        never
      >,
  });
  return { events, bodies };
}
it("streams native text and applies a full-message correction to the same display block", async () => {
  const f = fixture(),
    message = fauxAssistantMessage("hel");
  await f.events.consume([{ type: "message_start", message }]);
  await f.events.consume([
    {
      type: "message_update",
      usage: message.usage,
      changes: [{ type: "text_delta", contentIndex: 0, delta: "lo" }],
    },
  ]);
  await f.events.consume([
    {
      type: "message_update",
      usage: message.usage,
      changes: [
        {
          type: "message",
          message: { ...message, content: [{ type: "text", text: "corrected" }] },
        },
      ],
    },
  ]);
  const texts = f.bodies.filter((body) => body.type === "assistant.text.delta");
  expect(texts.map((body) => body.payload.text)).toEqual(["hel", "lo", "corrected"]);
  expect(new Set(texts.map((body) => body.payload.messageId)).size).toBe(1);
  expect(texts[2]!.payload.replace).toBe(true);
});
it("reconciles an overflow snapshot without appending the already displayed prefix again", async () => {
  const f = fixture(),
    message = fauxAssistantMessage("before");
  await f.events.consume([{ type: "message_start", message }]);
  await f.events.consume([
    {
      type: "snapshot",
      entries: [],
      tools: [],
      inbox: [],
      agent: {},
      usage: {},
      generation: {
        attempt: 1,
        message: { ...message, content: [{ type: "text", text: "before after" }] },
      },
    } as unknown as SnapshotEvent,
  ]);
  const texts = f.bodies.filter((body) => body.type === "assistant.text.delta");
  expect(texts.map((body) => body.payload.text)).toEqual(["before", " after"]);
  expect(texts[0]!.payload.messageId).toBe(texts[1]!.payload.messageId);
});
it("corrects a phase which was learned after the text was displayed", async () => {
  const f = fixture(),
    message = fauxAssistantMessage("done");
  await f.events.consume([{ type: "message_start", message }]);
  await f.events.consume([
    {
      type: "message_update",
      usage: message.usage,
      changes: [
        {
          type: "block",
          contentIndex: 0,
          block: {
            type: "text",
            text: "done",
            textSignature: JSON.stringify({ v: 1, phase: "final_answer" }),
          },
        },
      ],
    },
  ]);
  expect(f.bodies.at(-1)).toMatchObject({
    type: "assistant.text.delta",
    payload: { text: "done", replace: true, phase: "final_answer" },
  });
});
it.each(["completed", "aborted", "failed", "faulted"])(
  "reports the native compaction receipt: %s",
  async (outcome) => {
    const f = fixture(outcome);
    await f.events.consume([
      { type: "compaction_start", taskId: 2, reason: "threshold", blocking: true },
      { type: "compaction_end", taskId: 2, reason: "threshold" },
    ] as AgentEvent[]);
    expect(f.bodies.at(-1)).toMatchObject({
      type: "context.compaction.completed",
      payload: { status: outcome === "faulted" ? "failed" : outcome },
    });
  },
);
it("does not invent a successful result when a native Tool task has no result entry", async () => {
  const f = fixture();
  await f.events.consume([{ type: "tool_execution_end", toolCallId: "call", toolName: "bash" }]);
  expect(f.bodies.at(-1)).toMatchObject({
    type: "tool.completed",
    payload: { toolCallId: "task:3", outcome: "failed" },
  });
});

it("reconstructs a dropped Tool completion once from an overflow snapshot", async () => {
  const f = fixture();
  const entry = {
    id: 9,
    conversationId: 1,
    kind: "pi.tool-result",
    byTaskId: 3,
    model: [
      {
        role: "toolResult",
        toolCallId: "call",
        toolName: "bash",
        content: [{ type: "text", text: "persisted" }],
        isError: false,
        timestamp: 1,
      },
    ],
  };
  const snapshot = {
    type: "snapshot",
    entries: [entry],
    tools: [],
    compactions: [],
    inbox: [],
    agent: {},
    usage: {},
  } as unknown as SnapshotEvent;
  await f.events.consume([snapshot, snapshot]);
  expect(f.bodies.filter((body) => body.type === "tool.completed")).toEqual([
    {
      type: "tool.completed",
      payload: { toolCallId: "task:3", outcome: "completed", output: "persisted" },
    },
  ]);
});
it("translates the native completed-attempt retry number into the next attempt", async () => {
  const f = fixture();
  await f.events.samplingStarted({
    stepSequence: 1,
    stepSha256: "a".repeat(64),
    samplingAttempt: 1,
  });
  await f.events.consume([
    { type: "message_start", message: fauxAssistantMessage("partial") },
    { type: "auto_retry_start", attempt: 1, at: Date.now(), errorMessage: "transient" },
  ]);
  expect(f.bodies.at(-1)).toMatchObject({
    type: "model.sampling.retry.scheduled",
    payload: { completedSamplingAttempt: 1, nextSamplingAttempt: 2 },
  });
});

it.each([false, true])(
  "associates terminal-only Entries after snapshot loss (prior partial=%s)",
  async (priorPartial) => {
    const f = fixture();
    const first = fauxAssistantMessage(fauxToolCall("bash", { command: "true" }), {
      timestamp: 1,
      stopReason: "toolUse",
    });
    const second = fauxAssistantMessage("done", { timestamp: 1 });
    const identity = (sequence: number) => ({
      stepSequence: sequence,
      stepSha256: "a".repeat(64),
      samplingAttempt: 1,
    });
    await f.events.samplingStarted(identity(11));
    if (priorPartial) await f.events.consume([{ type: "message_start", message: first }]);
    await f.events.samplingStarted(identity(22));
    const snapshot = {
      type: "snapshot",
      entries: [
        { id: 3, conversationId: 1, kind: "pi.assistant", model: [first] },
        { id: 8, conversationId: 1, kind: "pi.assistant", model: [second] },
      ],
      tools: [],
      compactions: [],
      inbox: [],
      agent: {},
      usage: {},
    } as unknown as SnapshotEvent;
    await f.events.consume([
      snapshot,
      snapshot,
      { type: "message_end", entry: snapshot.entries[1]! },
    ]);
    expect(
      f.bodies
        .filter((body) => body.type === "model.sampling.completed")
        .map((body) => body.payload.stepSequence),
    ).toEqual([11, 22]);
  },
);

it("keeps the old recovered partial outside the next request's completion", async () => {
  const f = fixture(),
    old = fauxAssistantMessage("interrupted", { timestamp: 1 });
  f.events.baseline({
    type: "snapshot",
    entries: [],
    generation: { attempt: 1, message: old },
    tools: [],
    compactions: [],
    inbox: [],
    agent: {},
    usage: {},
  } as unknown as SnapshotEvent);
  await f.events.samplingStarted({
    stepSequence: 22,
    stepSha256: "b".repeat(64),
    samplingAttempt: 1,
  });
  await f.events.consume([
    {
      type: "message_end",
      entry: {
        id: 3,
        conversationId: 1,
        kind: "pi.assistant",
        model: [{ ...old, stopReason: "aborted" }],
      },
    },
  ] as unknown as AgentEvent[]);
  expect(f.bodies.filter((body) => body.type === "model.sampling.completed")).toEqual([]);
  const current = fauxAssistantMessage("continued", { timestamp: 2 });
  await f.events.consume([
    {
      type: "message_end",
      entry: { id: 8, conversationId: 1, kind: "pi.assistant", model: [current] },
    },
  ] as unknown as AgentEvent[]);
  expect(
    f.bodies
      .filter((body) => body.type === "model.sampling.completed")
      .map((body) => body.payload.stepSequence),
  ).toEqual([22]);
});

it("uses the pending request for native retry progress preceding its terminal-only Entry", async () => {
  const f = fixture();
  await f.events.samplingStarted({
    stepSequence: 11,
    stepSha256: "a".repeat(64),
    samplingAttempt: 1,
  });
  await f.events.consume([
    { type: "auto_retry_start", attempt: 1, at: Date.now(), errorMessage: "429" },
  ]);
  expect(f.bodies.at(-1)).toMatchObject({
    type: "model.sampling.retry.scheduled",
    payload: { stepSequence: 11, nextSamplingAttempt: 2 },
  });
});
