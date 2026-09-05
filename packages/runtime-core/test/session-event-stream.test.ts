import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import type { ConversationDetailResource, PiCloudEvent } from "@pi-cloud/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionEventStream } from "../src/session-event-stream.ts";
import { SessionEventHub } from "../src/session-event-hub.ts";

afterEach(() => vi.useRealTimers());

function response() {
  const emitter = new EventEmitter();
  return Object.assign(emitter, {
    destroyed: false,
    writableEnded: false,
    frames: [] as string[],
    write(chunk: string) {
      this.frames.push(chunk);
      return true;
    },
    close() {
      this.destroyed = true;
      emitter.emit("close");
    },
  });
}

describe("Session snapshot and live stream", () => {
  it("keeps one pending read across idle heartbeats and delivers the next event once", async () => {
    vi.useFakeTimers();
    const hub = new SessionEventHub();
    const stream = new SessionEventStream(
      { snapshot: () => ({ canonicalThroughSequence: 0, highWaterMark: 0, events: [] }) },
      hub,
      { heartbeatIntervalMs: 10 },
    );
    const opened = await stream.open({
      tenantId: "t",
      sessionId: "s",
      loadCanonical: async () => ({
        conversation: {} as ConversationDetailResource,
        canonicalThroughSequence: 0,
      }),
    });
    const output = response();
    const running = opened.pipe(output as unknown as ServerResponse);
    await vi.advanceTimersByTimeAsync(35);
    expect(output.frames.filter((frame) => frame.startsWith(":"))).toHaveLength(3);
    const event: PiCloudEvent = {
      schemaVersion: 1,
      eventId: "event",
      sessionId: "s",
      turnId: "turn",
      agentId: "root",
      seq: 1,
      occurredAt: new Date().toISOString(),
      type: "assistant.text.delta",
      payload: { text: "after idle" },
    };
    hub.publish("t", event);
    await vi.advanceTimersByTimeAsync(1);
    expect(output.frames.filter((frame) => frame.includes("after idle"))).toHaveLength(1);
    output.close();
    await expect(running).resolves.toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reloads canonical state when terminal eviction overtakes the database snapshot", async () => {
    const hub = new SessionEventHub();
    let loads = 0;
    const stream = new SessionEventStream(
      { snapshot: () => ({ canonicalThroughSequence: 4, highWaterMark: 4, events: [] }) },
      hub,
    );
    const opened = await stream.open({
      tenantId: "t",
      sessionId: "s",
      loadCanonical: async () => ({
        conversation: {
          marker: ++loads === 1 ? "old" : "completed",
        } as unknown as ConversationDetailResource,
        canonicalThroughSequence: loads === 1 ? 0 : 4,
      }),
    });
    const output = response();
    output.write = (chunk) => {
      output.frames.push(chunk);
      output.close();
      return true;
    };
    await opened.pipe(output as unknown as ServerResponse);
    expect(loads).toBe(2);
    expect(output.frames[0]).toContain("completed");
    hub.onApplicationShutdown();
  });
});
