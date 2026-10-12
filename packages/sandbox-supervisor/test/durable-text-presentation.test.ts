import { expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import type { LiveState } from "@earendil-works/pi-durable";
import type { NativeDocumentChange } from "@pi-cloud/pi-session-postgres/durable";
import {
  createPiCloudEventFactory,
  resolveDurableText,
  type DurableSessionCommit,
} from "@pi-cloud/protocol";
import { DurableTextPresentation } from "../src/durable/text-presentation.ts";
import { projectConversationTurnTranscript } from "../../runtime-core/src/conversation-turn-projection.ts";
const factory = () =>
  createPiCloudEventFactory({ sessionId: "session", turnId: "turn", agentId: "agent" });
const value = (text: string, task = 3, attempt = 1) =>
  ({
    run: { taskId: task, inputs: [] },
    generation: {
      attempt,
      message: fauxAssistantMessage(text, { timestamp: 1, stopReason: "pending" }),
    },
  }) as unknown as LiveState;
function change(before: LiveState | undefined, after: LiveState): NativeDocumentChange {
  const record = {
    id: 2,
    kind: "pi.live",
    version: 1,
    createdAt: 1,
    scope: { kind: "conversation", conversationId: 1 },
    history: "latest",
  };
  const doc = (v: LiveState) => ({ record, version: 1, value: v, deltasSinceBase: 0 });
  return {
    record,
    before: before ? doc(before) : undefined,
    after: doc(after),
  } as unknown as NativeDocumentChange;
}
const commit = (
  seq: number,
  writes: DurableSessionCommit["writes"] = [{ type: "document.change", id: 2 }],
): DurableSessionCommit => ({ seq, nextId: 20, writes });
it("references append, correction, truncation and deletion without copying bodies", () => {
  const text = new DurableTextPresentation({ conversationId: 1 }),
    f = factory();
  let previous: LiveState | undefined;
  const actual = [];
  for (const [i, next] of ["hello", "hello world", "help", "", "again"].entries()) {
    const after = value(next),
      c = commit(i + 1),
      prepared = text.prepare(c, [change(previous, after)], f);
    for (const d of prepared.texts) {
      expect(d.event.payload).not.toHaveProperty("text");
      actual.push(resolveDurableText(c, d, () => after));
    }
    prepared.confirmed();
    previous = after;
  }
  expect(actual.map((e) => [e.payload.text, !!e.payload.replace])).toEqual([
    ["hello", false],
    [" world", false],
    ["help", true],
    ["", true],
    ["again", false],
  ]);
});
it("settles interrupted text separately from a recovered request with the same task and timestamp", () => {
  const text = new DurableTextPresentation({ conversationId: 1 }),
    f = factory(),
    before = value("old partial");
  const a = commit(1),
    opening = text.prepare(a, [change(undefined, before)], f);
  opening.confirmed();
  const events = opening.texts.map((d) => resolveDurableText(a, d, () => before));
  const b = commit(2, [
    {
      type: "entry",
      value: {
        id: 8,
        kind: "pi.assistant",
        conversationId: 1,
        byTaskId: 3,
        model: [{ ...before.generation!.message!, stopReason: "aborted" }],
      },
    },
    { type: "document.change", id: 2 },
  ]);
  const ending = text.prepare(b, [change(before, {})], f);
  ending.confirmed();
  events.push(...ending.texts.map((d) => resolveDurableText(b, d, () => ({}))));
  const c = commit(3),
    next = value("new partial"),
    recovery = text.prepare(c, [change({}, next)], f);
  recovery.confirmed();
  events.push(...recovery.texts.map((d) => resolveDurableText(c, d, () => next)));
  expect(events[1]!.payload.settledMessageId).toBe("entry:8:0");
  expect(ending.coveredThrough).toBe(events[1]!.seq);
  expect(text.canCover(2)).toBe(false);
  expect(
    projectConversationTurnTranscript(events)
      .items.filter((i) => i.kind === "text")
      .map((i) => i.text),
  ).toEqual(["old partial", "new partial"]);
});
it("places coverage before a new partial and isolates Conversations", () => {
  const text = new DurableTextPresentation({ conversationId: 1 }),
    f = factory(),
    before = value("old"),
    after = value("new", 9);
  const c = commit(2, [
    {
      type: "entry",
      value: {
        id: 8,
        kind: "pi.assistant",
        conversationId: 1,
        byTaskId: 3,
        model: [fauxAssistantMessage("old")],
      },
    },
    { type: "document.change", id: 2 },
  ]);
  const prepared = text.prepare(c, [change(before, after)], f);
  expect(prepared.texts).toHaveLength(2);
  expect(prepared.coveredThrough).toBe(prepared.texts[0]!.event.seq);
  expect(prepared.texts[1]!.event.seq).toBeGreaterThan(prepared.coveredThrough!);
  expect(
    new DurableTextPresentation({ conversationId: 7 }).prepare(
      c,
      [change(before, after)],
      factory(),
    ).texts,
  ).toEqual([]);
});
it("updates a phase without another text body and adopts metadata only after ACK", () => {
  let phase: "final_answer" | undefined;
  const text = new DurableTextPresentation({ conversationId: 1, phase: () => phase }),
    f = factory(),
    first = value("done");
  first.generation!.message!.responseId = "response";
  const a = text.prepare(commit(1), [change(undefined, first)], f);
  a.confirmed();
  phase = "final_answer";
  const p = text.prepare(commit(2), [change(first, first)], f);
  expect(p.texts[0]).toMatchObject({
    source: { kind: "empty" },
    event: { payload: { phase: "final_answer" } },
  });
  expect(text.prepare(commit(2), [change(first, first)], f).texts).toHaveLength(1);
  p.confirmed();
  expect(text.prepare(commit(3), [change(first, first)], f).texts).toEqual([]);
});

it("clears a streamed block removed by the final Assistant Entry", () => {
  const text = new DurableTextPresentation({ conversationId: 1 }),
    f = factory(),
    before = value("first");
  before.generation!.message!.content.push({ type: "text", text: "removed" });
  const a = commit(1),
    opening = text.prepare(a, [change(undefined, before)], f);
  opening.confirmed();
  const events = opening.texts.map((d) => resolveDurableText(a, d, () => before));
  const b = commit(2, [
    {
      type: "entry",
      value: {
        id: 8,
        kind: "pi.assistant",
        conversationId: 1,
        byTaskId: 3,
        model: [fauxAssistantMessage("corrected")],
      },
    },
    { type: "document.change", id: 2 },
  ]);
  const settled = text.prepare(b, [change(before, {})], f);
  events.push(...settled.texts.map((d) => resolveDurableText(b, d, () => ({}))));
  expect(settled.texts[1]).toMatchObject({
    source: { kind: "empty" },
    event: { payload: { replace: true } },
  });
  expect(
    projectConversationTurnTranscript(events).items.flatMap((i) =>
      i.kind === "text" && i.text ? [i.text] : [],
    ),
  ).toEqual(["corrected"]);
});
