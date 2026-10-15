import { expect, it } from "vitest";
import type { LiveState } from "@earendil-works/pi-durable";
import type { NativeDocumentChange } from "@pi-cloud/pi-session-postgres/durable";
import {
  createPiCloudEventFactory,
  resolveDurableDisplay,
  type DurableSessionCommit,
} from "@pi-cloud/protocol";
import { prepareToolPresentation } from "../src/durable/tool-presentation.ts";
import { DurableTextPresentation } from "../src/durable/text-presentation.ts";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";

const factory = () =>
  createPiCloudEventFactory({ sessionId: "view", turnId: "turn", agentId: "agent" });
function document(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): NativeDocumentChange {
  const record = {
    id: 3,
    kind: "pi.live",
    scope: { kind: "conversation", conversationId: 1 },
    history: "latest",
    fork: "initial",
  };
  return {
    record,
    before: { record, version: 1, value: before, deltasSinceBase: 0 },
    after: { record, version: 1, value: after, deltasSinceBase: 0 },
  } as unknown as NativeDocumentChange;
}
const slot = (status: string, extra = {}) => ({
  taskId: 4,
  callId: "provider-reused",
  name: "bash",
  status,
  ...extra,
});
const task = (args: unknown, extra = {}) => ({
  type: "task",
  value: {
    id: 4,
    conversationId: 1,
    kind: "pi.tool",
    version: 1,
    input: { assistant: 2, callId: "provider-reused" },
    background: false,
    abortRequested: false,
    state: {
      status: "running",
      checkpoint: { phase: "execute", arguments: args, replay: "unsafe" },
    },
    ...extra,
  },
});
const commit = (writes: DurableSessionCommit["writes"]): DurableSessionCommit => ({
  seq: 1,
  nextId: 100,
  writes,
});
const options = { conversationId: 1, maximumOutputBytes: 65536 };

it("references validated arguments once and distinguishes repeated provider call IDs by task", () => {
  const args = { command: "x".repeat(80000) };
  for (const id of [4, 9]) {
    const c = commit([task(args, { id }), { type: "document.change", id: 3 }]);
    const doc = document(
      { tools: [slot("pending", { taskId: id })] },
      { tools: [slot("running", { taskId: id })] },
    );
    const descriptions = prepareToolPresentation(c, [doc], factory(), options);
    expect(descriptions).toHaveLength(1);
    expect(JSON.stringify(descriptions)).not.toContain(args.command);
    const event = resolveDurableDisplay(c, descriptions[0]!, () => doc.after!.value);
    expect(event).toMatchObject({
      type: "tool.started",
      payload: { toolCallId: `task:${id}`, input: args },
    });
    expect(prepareToolPresentation(c, [doc], factory(), { ...options, conversationId: 2 })).toEqual(
      [],
    );
    expect(
      prepareToolPresentation(
        c,
        [
          document(
            doc.after!.value as Record<string, unknown>,
            doc.after!.value as Record<string, unknown>,
          ),
        ],
        factory(),
        options,
      ),
    ).toEqual([]);
  }
});

it("refuses to display execution before a complete admitted native intent", () => {
  const doc = document({ tools: [slot("pending")] }, { tools: [slot("running")] });
  expect(() => prepareToolPresentation(commit([]), [doc], factory(), options)).toThrow(
    "execution intent",
  );
  expect(() =>
    prepareToolPresentation(
      commit([task({}, { abortRequested: true })]),
      [doc],
      factory(),
      options,
    ),
  ).toThrow("execution intent");
});

function resultFixture(text: string, isError = false) {
  const entry = {
    type: "entry",
    value: {
      id: 5,
      conversationId: 1,
      byTaskId: 4,
      kind: "pi.tool-result",
      model: [
        {
          role: "toolResult",
          toolCallId: "provider-reused",
          toolName: "bash",
          isError,
          timestamp: 1,
          content: [
            { type: "text", text },
            { type: "image", mimeType: "image/png", data: "NOT_IN_DISPLAY" },
          ],
        },
      ],
    },
  };
  const c = commit([
    entry,
    task({}, { state: { status: "terminal", outcome: { status: "completed", value: null } } }),
    { type: "document.change", id: 3 },
  ]);
  const doc = document({ tools: [slot("running")] }, { tools: [slot("done", { entry: 5 })] });
  return { c, doc };
}

it("uses the canonical after-hook result and image metadata without copying body or pixels", () => {
  const text = "after hook ✓\u0000\ud800";
  const { c, doc } = resultFixture(text, true);
  const descriptions = prepareToolPresentation(c, [doc], factory(), options);
  expect(descriptions).toHaveLength(1);
  expect(JSON.stringify(descriptions)).not.toContain("after hook");
  expect(JSON.stringify(descriptions)).not.toContain("NOT_IN_DISPLAY");
  expect(resolveDurableDisplay(c, descriptions[0]!, () => undefined)).toMatchObject({
    type: "tool.completed",
    payload: { toolCallId: "task:4", outcome: "failed", output: `${text}\n[Image: image/png]` },
  });
  const bounded = prepareToolPresentation(c, [doc], factory(), {
    ...options,
    maximumOutputBytes: 7,
  });
  expect(resolveDurableDisplay(c, bounded[0]!, () => undefined)).toMatchObject({
    payload: {
      output:
        Buffer.from(`${text}\n[Image: image/png]`).subarray(0, 7).toString("utf8") +
        "\n[Display truncated]",
    },
  });
});

it("does not present retained tool history in another native entry as new execution", () => {
  const { c } = resultFixture("old context");
  Object.assign(c.writes[0]!.value as object, { kind: "pi.compaction" });
  expect(prepareToolPresentation(c, [], factory(), options)).toEqual([]);
});

it("reports a vanished orphan as failed and gives unoffered results an Entry identity", () => {
  const missing = prepareToolPresentation(
    commit([task({}, { state: { status: "terminal" } })]),
    [document({ tools: [slot("running")] }, { tools: [] })],
    factory(),
    options,
  );
  expect(resolveDurableDisplay(commit([]), missing[0]!, () => undefined)).toMatchObject({
    payload: {
      toolCallId: "task:4",
      outcome: "failed",
      output: "Tool task ended without a result",
    },
  });
  const { c } = resultFixture("not offered", true);
  const doc = document(
    {},
    { tools: [{ callId: "provider-reused", name: "bash", status: "done", entry: 5 }] },
  );
  Object.assign(c.writes[0]!.value as object, { byTaskId: 90 });
  const unoffered = prepareToolPresentation(c, [doc], factory(), options);
  expect(unoffered[0]?.event.payload.toolCallId).toBe("entry:5");
});

it("covers a canonical Tool result before a new partial in the same native commit", () => {
  const { c, doc } = resultFixture("settled");
  const before = doc.before!.value as unknown as LiveState;
  const after = {
    ...(doc.after!.value as object),
    run: { taskId: 8, inputs: [] },
    generation: { attempt: 1, message: fauxAssistantMessage("next", { stopReason: "pending" }) },
  };
  const change = document(before as unknown as Record<string, unknown>, after);
  const f = factory(),
    toolEvents = prepareToolPresentation(c, [change], f, options);
  const text = new DurableTextPresentation({ conversationId: 1 }).prepare(c, [change], f);
  expect(text.coveredThrough).toBe(toolEvents[0]!.event.seq);
  expect(text.events[0]!.event.seq).toBeGreaterThan(text.coveredThrough!);
});
