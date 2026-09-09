import { expect, it } from "vitest";
import type { PiCloudEvent } from "@pi-cloud/protocol";
import { SessionLiveView } from "../src/session-live-view.ts";

it("keeps an in-flight snapshot when committed content is evicted", () => {
  const view = new SessionLiveView(async () => () => {});
  const base = {
    schemaVersion: 1 as const,
    sessionId: crypto.randomUUID(),
    turnId: crypto.randomUUID(),
    agentId: "root",
    occurredAt: new Date().toISOString(),
  };
  const event: PiCloudEvent = {
    ...base,
    eventId: crypto.randomUUID(),
    seq: 1,
    type: "assistant.text.delta",
    payload: { text: "already visible" },
  };
  try {
    view.accept("tenant", event);
    view.accept("tenant", event);
    const reader = view.snapshot("tenant", base.sessionId);
    view.accept("tenant", {
      ...base,
      eventId: crypto.randomUUID(),
      seq: 2,
      type: "turn.completed",
      payload: { stopReason: "stop" },
    });
    expect(reader.events).toEqual([event]);
    expect(view.snapshot("tenant", base.sessionId).events).toEqual([]);
    expect(view.statistics().cachedBytes).toBe(0);
  } finally {
    view.close();
  }
});
