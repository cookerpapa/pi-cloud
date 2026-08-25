import { createPiCloudEventFactory } from "@pi-cloud/protocol";
import { describe, expect, it } from "vitest";
import { SessionEventHub } from "../src/index.ts";

function fixture() {
  let eventNumber = 0;
  return createPiCloudEventFactory(
    { sessionId: "session-1", turnId: "turn-1", agentId: "root" },
    {
      clock: () => new Date("2026-07-18T08:00:00.000Z"),
      idGenerator: () => `${String(++eventNumber).padStart(8, "0")}-0000-4000-8000-000000000000`,
    },
  );
}

describe("SessionEventHub", () => {
  it("delivers committed high-water hints to all current subscribers", async () => {
    const hub = new SessionEventHub();
    const first = hub.subscribe("tenant-1", "session-1");
    const second = hub.subscribe("tenant-1", "session-1");
    const event = fixture().next({
      type: "assistant.text.delta",
      payload: { text: "hello" },
    });

    const pending = first.next();
    hub.publish("tenant-1", event);
    await expect(pending).resolves.toEqual({ throughSequence: 1, event });
    await expect(second.next()).resolves.toEqual({ throughSequence: 1, event });
    first.close();
    second.close();
  });

  it("preserves live events, isolates sessions, and supports reconnect resync", async () => {
    const hub = new SessionEventHub();
    const first = hub.subscribe("tenant-1", "session-1");
    const other = hub.subscribe("tenant-1", "session-2");
    const foreign = hub.subscribe("tenant-2", "session-1");
    const factory = fixture();
    const firstEvent = factory.next({ type: "assistant.text.delta", payload: { text: "one" } });
    const secondEvent = factory.next({ type: "assistant.text.delta", payload: { text: "two" } });
    hub.publish("tenant-1", firstEvent);
    hub.publish("tenant-1", secondEvent);

    await expect(first.next()).resolves.toEqual({ throughSequence: 1, event: firstEvent });
    await expect(first.next()).resolves.toEqual({ throughSequence: 2, event: secondEvent });
    expect(other.closed).toBe(false);
    expect(foreign.closed).toBe(false);
    hub.resyncAll();
    await expect(first.next()).resolves.toEqual({ throughSequence: null });
    await expect(other.next()).resolves.toEqual({ throughSequence: null });
    await expect(foreign.next()).resolves.toEqual({ throughSequence: null });
    hub.onApplicationShutdown();
    expect(first.closed).toBe(true);
    expect(other.closed).toBe(true);
    expect(foreign.closed).toBe(true);
  });
});
