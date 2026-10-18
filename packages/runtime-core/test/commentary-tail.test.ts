import { expect, it } from "vitest";
import type { PiCloudEvent } from "@pi-cloud/protocol";
import { CompactEventTail } from "../src/compact-event-tail.ts";
import { SessionLiveView } from "../src/session-live-view.ts";
import { projectConversationTurnTranscript } from "../src/conversation-turn-projection.ts";

const event = (seq: number, payload: Record<string, unknown> = {}): PiCloudEvent =>
  ({
    schemaVersion: 1,
    eventId: `e${seq}`,
    sessionId: "s",
    turnId: "t",
    agentId: "root",
    seq,
    occurredAt: new Date().toISOString(),
    type: "assistant.text.delta",
    payload: { text: "abc", phase: "commentary", messageId: "m", ...payload },
  }) as PiCloudEvent;

it("compacts same-message commentary while delivering each original live event and retaining immutable readers", async () => {
  const live = new SessionLiveView(async () => {}),
    sub = live.eventHub.subscribe("tenant", "s");
  try {
    for (let n = 1; n <= 1000; n++) live.accept("tenant", event(n));
    const borrowed = live.snapshot("tenant", "s");
    expect(borrowed.events).toHaveLength(1);
    expect(projectConversationTurnTranscript(borrowed.events).items).toMatchObject([
      { text: "abc".repeat(1000), messageId: "m" },
    ]);
    for (let n = 1; n <= 1000; n++) expect((await sub.next())?.event?.seq).toBe(n);
    const settled = event(1001, {
      text: "abc".repeat(1000),
      replace: true,
      settledMessageId: "entry:9:0",
    });
    live.accept("tenant", settled);
    live.cover("tenant", "s", 1001);
    expect(live.snapshot("tenant", "s").events).toEqual([]);
    expect(borrowed.events).toHaveLength(1);
    const base = projectConversationTurnTranscript([settled]);
    expect(
      projectConversationTurnTranscript([event(1002, { text: "new" })], base).items,
    ).toMatchObject([
      { messageId: "entry:9:0", text: "abc".repeat(1000) },
      { messageId: "m", text: "new" },
    ]);
  } finally {
    sub.close();
    live.close();
  }
});

it.each(
  [
    [event(1), event(2, { messageId: "other" })],
    [event(1), event(2, { phase: "final_answer" })],
    [event(1), event(2, { replace: true })],
    [event(1, { settledMessageId: "entry:1:0" }), event(2)],
    [event(1), event(3)],
    [event(1, { messageId: undefined }), event(2, { messageId: undefined })],
  ].map((events, n) => ({ n, events })),
)("preserves commentary identity and sequence boundary $n", ({ events }) => {
  const tail = new CompactEventTail();
  events.forEach((value) => tail.accept(value));
  expect(tail.size).toBe(2);
  expect(projectConversationTurnTranscript(tail.events)).toEqual(
    projectConversationTurnTranscript(events),
  );
});
