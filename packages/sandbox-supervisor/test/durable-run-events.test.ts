import { expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { AgentEvent, SnapshotEvent, TaskRecord } from "@earendil-works/pi-durable";
import type { PiCloudEventBody } from "@pi-cloud/protocol";
import { DurableRunEvents } from "../src/durable/run-events.ts";
function fixture(outcome = "completed") {
  const bodies: PiCloudEventBody[] = [];
  const events = new DurableRunEvents({
    emit: async (body) => {
      bodies.push(body);
    },
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
it("does not publish assistant text through the post-commit observation path", async () => {
  const f = fixture(),
    message = fauxAssistantMessage("visible");
  await f.events.consume([
    { type: "message_start", message },
    {
      type: "message_update",
      usage: message.usage,
      changes: [{ type: "text_delta", contentIndex: 0, delta: " text" }],
    },
  ]);
  expect(f.bodies).toEqual([]);
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
it("does not publish a second Tool result through the post-commit observer", async () => {
  const f = fixture();
  await f.events.consume([{ type: "tool_execution_end", toolCallId: "call", toolName: "bash" }]);
  expect(f.bodies).toEqual([]);
});

it("does not duplicate native Tool presentation when an observer overflows", async () => {
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
  expect(f.bodies.filter((body) => body.type === "tool.completed")).toEqual([]);
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
