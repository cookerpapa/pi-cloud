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
    write(chunk: string): boolean {
      this.frames.push(chunk);
      return true;
    },
    close() {
      this.destroyed = true;
      emitter.emit("close");
    },
    destroy() {
      this.close();
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
        conversation: { turns: [] } as unknown as ConversationDetailResource,
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

  it("captures the immutable tail before PG so concurrent eviction needs no read retry", async () => {
    const hub = new SessionEventHub();
    let loads = 0;
    let captured = false;
    const stream = new SessionEventStream(
      {
        snapshot: () => {
          captured = true;
          return { canonicalThroughSequence: 0, highWaterMark: 0, events: [] };
        },
      },
      hub,
    );
    const opened = await stream.open({
      tenantId: "t",
      sessionId: "s",
      loadCanonical: async () => {
        expect(captured).toBe(true);
        loads++;
        return {
          conversation: { marker: "completed", turns: [] } as unknown as ConversationDetailResource,
          canonicalThroughSequence: 4,
        };
      },
    });
    const output = response();
    output.write = (chunk) => {
      output.frames.push(chunk);
      if (chunk.includes("stream.end")) output.close();
      return true;
    };
    await opened.pipe(output as unknown as ServerResponse);
    expect(loads).toBe(1);
    expect(output.frames.join("")).toContain("completed");
    hub.onApplicationShutdown();
  });

  it("releases a stalled socket without holding another reader or the snapshot", async () => {
    vi.useFakeTimers();
    const hub = new SessionEventHub(),
      release = vi.fn();
    const stream = new SessionEventStream(
      {
        retainSession: async () => release,
        snapshot: () => ({ canonicalThroughSequence: 0, highWaterMark: 0, events: [] }),
      },
      hub,
      { sendTimeoutMs: 5 },
    );
    const opened = await stream.open({
      tenantId: "t",
      sessionId: "s",
      loadCanonical: async () => ({
        conversation: { turns: [] } as unknown as ConversationDetailResource,
        canonicalThroughSequence: 0,
      }),
    });
    const output = response();
    output.write = () => false;
    const running = opened.pipe(output as unknown as ServerResponse);
    await vi.advanceTimersByTimeAsync(6);
    await running;
    expect(output.destroyed).toBe(true);
    expect(release).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
