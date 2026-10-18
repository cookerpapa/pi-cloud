import { EventEmitter } from "node:events";
import type { ServerResponse } from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import type { PiCloudEvent, ConversationDetailResource } from "@pi-cloud/protocol";
import { SessionEventHub } from "../src/session-event-hub.ts";
import { SessionEventStream } from "../src/session-event-stream.ts";
import { projectConversationTurnTranscript } from "../src/conversation-turn-projection.ts";

afterEach(() => vi.useRealTimers());
const event = (seq: number, text = '中文🙂"\n\\'): PiCloudEvent => ({
  schemaVersion: 1,
  eventId: `e${seq}`,
  sessionId: "s",
  turnId: "t",
  agentId: "root",
  seq,
  occurredAt: "2026-10-18T00:00:00.000Z",
  type: "assistant.text.delta",
  payload: { messageId: "m", text },
});
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
    destroy() {
      this.destroyed = true;
      emitter.emit("close");
    },
  });
}
const snapshot = (events: PiCloudEvent[]) => ({
  canonicalThroughSequence: events.at(-1)?.seq ?? 0,
  conversation: {
    turns: [
      {
        turnId: "t",
        runId: "r",
        state: "running",
        ...(events.length ? { transcript: projectConversationTurnTranscript(events) } : {}),
      },
    ],
  } as ConversationDetailResource,
});
const snapshotBody = (output: ReturnType<typeof response>) =>
  JSON.parse(
    output.frames
      .filter((frame) => frame.startsWith("event: stream.part"))
      .map((frame) => JSON.parse(frame.slice(frame.indexOf("data: ") + 6)))
      .join(""),
  );

it("counts bytes only for pending readers, once per broadcast, and never retains a serialized copy", async () => {
  const hub = new SessionEventHub(),
    read = vi.fn(() => "text");
  const value = event(1);
  Object.defineProperty(value.payload, "text", { enumerable: true, get: read });
  hub.publish("tenant", value);
  expect(read).not.toHaveBeenCalled();
  const a = hub.subscribe("tenant", "s"),
    b = hub.subscribe("tenant", "s");
  const waiting = [a.next(), b.next()];
  hub.publish("tenant", value);
  for (const received of await Promise.all(waiting)) expect(received?.event).toBe(value);
  expect(read).not.toHaveBeenCalled();
  hub.publish("tenant", value);
  expect(read).toHaveBeenCalledOnce();
  expect((await a.next())?.event).toBe(value);
  expect((await b.next())?.event).toBe(value);
  hub.onApplicationShutdown();
});

it("admits the exact encoded byte budget, releases it on dequeue and clears every pending channel on overflow", async () => {
  const value = event(1),
    hub = new SessionEventHub(Buffer.byteLength(JSON.stringify(value)));
  const sub = hub.subscribe("tenant", "s");
  hub.publish("tenant", value);
  expect(await sub.next()).toMatchObject({ event: value });
  hub.publish("tenant", event(2));
  hub.publishObservation("tenant", {
    type: "run.path",
    sessionId: "s",
    turnId: "t",
    runId: "r",
    generation: 1,
    sentAt: 100,
    observedAt: 100,
  });
  hub.publish("tenant", event(3));
  expect(await sub.next()).toEqual({ throughSequence: null });
  hub.publish("tenant", event(4));
  expect(await sub.next()).toBeUndefined();
  sub.close();
  expect(hub.hasSubscribers("tenant", "s")).toBe(false);
  const reopened = hub.subscribe("tenant", "s");
  hub.publish("tenant", value);
  expect(await reopened.next()).toMatchObject({ event: value });
  hub.resyncSession("tenant", "s");
  expect(await reopened.next()).toEqual({ throughSequence: null });
  hub.onApplicationShutdown();
  expect(await reopened.next()).toBeUndefined();
});

it("retains the event-count bound and permits an oversized value already being consumed", async () => {
  const hub = new SessionEventHub(),
    sub = hub.subscribe("tenant", "s");
  for (let n = 1; n <= 1025; n++) hub.publish("tenant", event(n));
  expect(await sub.next()).toEqual({ throughSequence: null });
  hub.onApplicationShutdown();
  const small = new SessionEventHub(1),
    direct = small.subscribe("tenant", "s");
  const pending = direct.next(),
    large = event(1, "x".repeat(100000));
  small.publish("tenant", large);
  expect((await pending)?.event).toBe(large);
  small.onApplicationShutdown();
});

it("resyncs a periodically draining slow socket without delaying a healthy reader or losing replacement content", async () => {
  vi.useFakeTimers();
  const values = Array.from({ length: 5 }, (_, n) => event(n + 1, "x".repeat(1000)));
  const hub = new SessionEventHub(Buffer.byteLength(JSON.stringify(values[0])) * 2);
  let canonical: PiCloudEvent[] = [];
  const source = {
    snapshot: () => ({
      canonicalThroughSequence: canonical.at(-1)?.seq ?? 0,
      highWaterMark: canonical.at(-1)?.seq ?? 0,
      events: [],
    }),
  };
  const stream = new SessionEventStream(source, hub, { sendTimeoutMs: 5_000 });
  const open = () =>
    stream.open({
      tenantId: "tenant",
      sessionId: "s",
      loadCanonical: async () => snapshot(canonical),
    });
  const slow = response(),
    fast = response();
  slow.write = (frame) => {
    slow.frames.push(frame);
    return !frame.startsWith("event: assistant.text.delta");
  };
  const slowPipe = (await open()).pipe(slow as unknown as ServerResponse);
  const fastPipe = (await open()).pipe(fast as unknown as ServerResponse);
  try {
    await vi.advanceTimersByTimeAsync(0);
    hub.publish("tenant", values[0]!);
    await vi.advanceTimersByTimeAsync(0);
    hub.publish("tenant", values[1]!);
    await vi.advanceTimersByTimeAsync(4000);
    slow.emit("drain");
    await vi.advanceTimersByTimeAsync(0);
    for (const value of values.slice(2)) hub.publish("tenant", value);
    await vi.advanceTimersByTimeAsync(4000);
    expect(slow.destroyed).toBe(false); // no write has reached the 5-second deadline
    expect(fast.frames.filter((f) => f.startsWith("event: assistant.text.delta"))).toHaveLength(5);
    slow.emit("drain");
    await slowPipe;
    expect(slow.frames.filter((f) => f.startsWith("event: assistant.text.delta"))).toHaveLength(2);
    canonical = values;
    const replacement = response();
    replacement.write = (frame) => {
      replacement.frames.push(frame);
      if (frame.startsWith("event: stream.end")) replacement.destroy();
      return true;
    };
    await (await open()).pipe(replacement as unknown as ServerResponse);
    expect(snapshotBody(replacement).conversation.turns[0].transcript.items[0].text).toBe(
      "x".repeat(5000),
    );
  } finally {
    slow.destroy();
    fast.destroy();
    hub.onApplicationShutdown();
    await Promise.all([slowPipe, fastPipe]);
  }
});

it("recovers a single over-budget pending event through a larger framed snapshot", async () => {
  const hub = new SessionEventHub(128),
    source = { snapshot: () => ({ canonicalThroughSequence: 0, highWaterMark: 0, events: [] }) };
  const stream = new SessionEventStream(source, hub);
  const large = event(1, "中文🙂".repeat(20000));
  const opened = await stream.open({
    tenantId: "tenant",
    sessionId: "s",
    loadCanonical: async () => snapshot([]),
  });
  hub.publish("tenant", large);
  const output = response();
  await opened.pipe(output as unknown as ServerResponse); // initial snapshot then resync marker
  expect(output.frames.some((f) => f.startsWith("event: assistant.text.delta"))).toBe(false);
  const replacement = await stream.open({
    tenantId: "tenant",
    sessionId: "s",
    loadCanonical: async () => snapshot([large]),
  });
  const recovered = response();
  recovered.write = (frame) => {
    recovered.frames.push(frame);
    if (frame.startsWith("event: stream.end")) recovered.destroy();
    return true;
  };
  await replacement.pipe(recovered as unknown as ServerResponse);
  expect(snapshotBody(recovered).conversation.turns[0].transcript.items[0].text).toBe(
    "中文🙂".repeat(20000),
  );
  hub.onApplicationShutdown();
  output.destroy();
});
