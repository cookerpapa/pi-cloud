import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  type PiCloudEvent,
  type SessionViewSnapshotResource,
} from "@pi-cloud/protocol";
import { describe, expect, it, vi } from "vitest";
import { SseFrameParser, streamSessionEvents, type SessionStreamStatus } from "../src/sse.ts";
import { sessionJsonFrames } from "../../runtime-core/src/session-stream-framing.ts";
import { projectConversationTurnTranscript } from "../../runtime-core/src/conversation-turn-projection.ts";
import { SESSION_STREAM_MAX_FRAME_BYTES } from "@pi-cloud/protocol";

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const TURN_ID = "20000000-0000-4000-8000-000000000001";
const CREATED_AT = "2026-07-19T00:00:00.000Z";

it("stops reconnecting for a deleted or unauthorized Session", async () => {
  const request = vi.fn(async () => new Response(null, { status: 404 }));
  await expect(
    streamSessionEvents({
      sessionId: SESSION_ID,
      signal: new AbortController().signal,
      fetchImplementation: request,
      onSnapshot() {},
      onEvent() {},
      onStatus() {},
    }),
  ).rejects.toThrow("404");
  expect(request).toHaveBeenCalledTimes(1);
});

it("releases an error response before retrying or failing the SSE request", async () => {
  const cancel = vi.fn();
  await expect(
    streamSessionEvents({
      sessionId: SESSION_ID,
      signal: new AbortController().signal,
      fetchImplementation: async () =>
        new Response(new ReadableStream({ cancel }), { status: 404 }),
      onSnapshot() {},
      onEvent() {},
      onStatus() {},
    }),
  ).rejects.toThrow("404");
  expect(cancel).toHaveBeenCalledOnce();
});

function event(
  sequence: number,
  text: string,
): Extract<PiCloudEvent, { type: "assistant.text.delta" }> {
  return {
    schemaVersion: 1,
    eventId: `30000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    sessionId: SESSION_ID,
    turnId: TURN_ID,
    agentId: "root",
    seq: sequence,
    occurredAt: CREATED_AT,
    type: "assistant.text.delta",
    payload: { text },
  };
}

function snapshot(liveEvents: PiCloudEvent[] = []): SessionViewSnapshotResource {
  return {
    schemaVersion: 2,
    conversation: {
      project: {
        projectId: "40000000-0000-4000-8000-000000000001",
        workspaceId: "50000000-0000-4000-8000-000000000001",
        name: "SSE test",
        createdAt: CREATED_AT,
        source: { kind: "empty", status: "ready" },
        environment: {
          environmentVersionId: "60000000-0000-4000-8000-000000000001",
          versionNumber: 1,
          profileKey: "pi-cloud-fullstack",
          profileVersion: "1",
          imageRevision: "test",
          specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
          recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
          recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
          state: "pending",
          active: true,
          createdAt: CREATED_AT,
        },
      },
      session: {
        sessionId: SESSION_ID,
        title: "SSE test",
        projectId: "40000000-0000-4000-8000-000000000001",
        workspaceId: "50000000-0000-4000-8000-000000000001",
        workspaceState: "attached",
        state: "running",
        executionMode: "elastic",
        sandboxProfileKey: "standard",
        workingDirectory: "/workspace",
        modelProfileId: "70000000-0000-4000-8000-000000000001",
        createdAt: CREATED_AT,
        updatedAt: CREATED_AT,
        lastActiveAt: CREATED_AT,
      },
      inheritedMessages: [],
      turns: liveEvents.length
        ? [
            {
              turnId: TURN_ID,
              runId: "80000000-0000-4000-8000-000000000001",
              mailboxPosition: 1,
              prompt: "Continue",
              state: "running",
              acceptedAt: CREATED_AT,
              transcript: projectConversationTurnTranscript(liveEvents),
            },
          ]
        : [],
      historyTruncated: false,
    },
  };
}

function frame(name: string, value: unknown): string {
  if (name === "session.snapshot") return [...sessionJsonFrames(value, "snapshot")].join("");
  return `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
}

function eventStream(body: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = encoder.encode(body),
          midpoint = Math.floor(bytes.length / 2);
        controller.enqueue(bytes.subarray(0, midpoint));
        controller.enqueue(bytes.subarray(midpoint));
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream; charset=utf-8" } },
  );
}

describe("cursor-free SSE Session client", () => {
  it("parses fragmented CRLF frames, comments, and multiline data", () => {
    const parser = new SseFrameParser();
    expect(parser.push(": heartbeat\r\n\r")).toEqual([]);
    expect(parser.push("\nevent: note\r\ndata: first\r\ndata: second\r\n\r\n")).toEqual([
      { event: "note", data: "first\nsecond" },
    ]);
  });

  it("bounds individual frames without limiting a network chunk containing many frames", () => {
    const parser = new SseFrameParser();
    expect(parser.push(frame("note", "x".repeat(1000)).repeat(1000))).toHaveLength(1000);
    expect(() => parser.push(frame("note", "x".repeat(SESSION_STREAM_MAX_FRAME_BYTES)))).toThrow(
      "buffer limit",
    );
  });

  it("materializes a snapshot over twenty MiB through bounded frames without replaying text", async () => {
    const payload = '中文🙂\\"\n'.repeat(2_000_000);
    const value = snapshot([event(1, "placeholder")]);
    const item = value.conversation.turns[0]!.transcript!.items[0]!;
    if (item.kind !== "text") throw new Error("Missing text fixture");
    item.text = payload;
    const frames = [...sessionJsonFrames(value, "snapshot")];
    expect(frames.every((part) => Buffer.byteLength(part) <= SESSION_STREAM_MAX_FRAME_BYTES)).toBe(
      true,
    );
    expect(Buffer.byteLength(frames.join(""))).toBeGreaterThan(20 * 1024 * 1024);
    const abort = new AbortController();
    let snapshots = 0;
    await streamSessionEvents({
      sessionId: SESSION_ID,
      signal: abort.signal,
      fetchImplementation: async () => eventStream(frames.join("")),
      onStatus() {},
      onEvent() {
        throw new Error("Snapshot must not become replayed live events");
      },
      onSnapshot(received) {
        snapshots++;
        expect(received).toEqual(value);
        abort.abort();
      },
    });
    expect(snapshots).toBe(1);
  }, 30000);

  it("discards an interrupted snapshot and applies only the complete replacement", async () => {
    const value = snapshot([event(1, "whole value")]);
    const complete = [...sessionJsonFrames(value, "snapshot")];
    const abort = new AbortController();
    let calls = 0,
      applied = 0;
    await streamSessionEvents({
      sessionId: SESSION_ID,
      signal: abort.signal,
      retryDelayMs: 0,
      onStatus() {},
      onEvent() {},
      fetchImplementation: async () =>
        eventStream((++calls === 1 ? complete.slice(0, -1) : complete).join("")),
      onSnapshot(received) {
        applied++;
        expect(received).toEqual(value);
        abort.abort();
      },
    });
    expect(calls).toBe(2);
    expect(applied).toBe(1);
  });

  it("delivers a large complete Tool call once after its last frame", async () => {
    const abort = new AbortController(),
      delivered: PiCloudEvent[] = [];
    const value: PiCloudEvent = {
      ...event(1, ""),
      type: "tool.started",
      payload: {
        toolCallId: "large",
        toolName: "write",
        input: JSON.parse(
          JSON.stringify({ content: "代码🙂".repeat(100_000) }).slice(0, -1) +
            ',"__proto__":{"keep":true},"nested":{"__proto__":17}}',
        ),
      },
    };
    const body = [
      ...sessionJsonFrames(snapshot(), "snapshot"),
      ...sessionJsonFrames(value, "event", value.type),
    ].join("");
    await streamSessionEvents({
      sessionId: SESSION_ID,
      signal: abort.signal,
      onStatus() {},
      onSnapshot() {},
      fetchImplementation: async () => eventStream(body),
      onEvent(e) {
        delivered.push(e);
        abort.abort();
      },
    });
    expect(delivered).toEqual([value]);
    expect(Object.getPrototypeOf((delivered[0]!.payload as { input: unknown }).input)).toBe(
      Object.prototype,
    );
  });

  it("reconnects with a replacement snapshot and never sends a browser cursor", async () => {
    const controller = new AbortController();
    const headers: Headers[] = [];
    const snapshots: SessionViewSnapshotResource[] = [];
    const delivered: number[] = [];
    const statuses: SessionStreamStatus[] = [];
    let call = 0;
    const fetchImplementation: typeof fetch = async (_input, init) => {
      headers.push(new Headers(init?.headers));
      call += 1;
      return call === 1
        ? eventStream(`${frame("session.snapshot", snapshot([event(1, "first")]))}`)
        : eventStream(
            `${frame("session.snapshot", snapshot([event(1, "first")]))}${frame(
              "assistant.text.delta",
              event(2, "second"),
            )}`,
          );
    };

    await streamSessionEvents({
      sessionId: SESSION_ID,
      signal: controller.signal,
      retryDelayMs: 0,
      authorizationToken: `api-${"a".repeat(48)}`,
      fetchImplementation,
      onSnapshot(value) {
        snapshots.push(value);
      },
      onEvent(value) {
        delivered.push(value.seq);
        controller.abort();
      },
      onStatus(status) {
        statuses.push(status);
      },
    });

    expect(headers).toHaveLength(2);
    expect(headers.every((value) => !value.has("last-event-id"))).toBe(true);
    expect(snapshots).toHaveLength(2);
    expect(delivered).toEqual([2]);
    expect(statuses.map((status) => status.phase)).toContain("reconnecting");
  });

  it("rejects a live event that arrives before the replacement snapshot", async () => {
    const statuses: SessionStreamStatus[] = [];
    await expect(
      streamSessionEvents({
        sessionId: SESSION_ID,
        signal: new AbortController().signal,
        retryDelayMs: 0,
        fetchImplementation: async () =>
          eventStream(frame("assistant.text.delta", event(1, "bad"))),
        onSnapshot() {},
        onEvent() {
          throw new Error("invalid frame must not be delivered");
        },
        onStatus(status) {
          statuses.push(status);
        },
      }),
    ).rejects.toThrow("before its Session snapshot");
    expect(statuses.at(-1)).toMatchObject({ phase: "failed" });
  });
});
