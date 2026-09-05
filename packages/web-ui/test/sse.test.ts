import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  type PiCloudEvent,
  type SessionViewSnapshotResource,
} from "@pi-cloud/protocol";
import { describe, expect, it, vi } from "vitest";
import { SseFrameParser, streamSessionEvents, type SessionStreamStatus } from "../src/sse.ts";

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

function event(sequence: number, text: string): PiCloudEvent {
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
    schemaVersion: 1,
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
      turns: [],
      historyTruncated: false,
    },
    liveEvents,
  };
}

function frame(name: string, value: unknown): string {
  return `event: ${name}\ndata: ${JSON.stringify(value)}\n\n`;
}

function eventStream(body: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const midpoint = Math.floor(body.length / 2);
        controller.enqueue(encoder.encode(body.slice(0, midpoint)));
        controller.enqueue(encoder.encode(body.slice(midpoint)));
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

  it("accepts a bounded long-session snapshot frame larger than one MiB", () => {
    const parser = new SseFrameParser();
    const payload = "x".repeat(2 * 1_024 * 1_024);
    expect(parser.push(`event: snapshot\ndata: ${payload}\n\n`)).toEqual([
      { event: "snapshot", data: payload },
    ]);
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
