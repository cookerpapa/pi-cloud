import {
  createExecutionGrant,
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
  type EventPublishMessage,
} from "@pi-cloud/protocol";
import { describe, expect, it, vi } from "vitest";
import type { AgentEventDurableCommit } from "../src/agent-event-authority.ts";
import {
  HttpAgentEventIngestor,
  JetStreamAgentEventIngestor,
} from "../src/jetstream-agent-event-log.ts";

function id(index: number, suffix: number): string {
  return `${String(index).padStart(8, "0")}-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
}

function publication(index: number): EventPublishMessage {
  const message = parseSupervisorToControlMessage({
    protocolVersion: 1,
    messageId: id(index, 1),
    sentAt: "2026-08-25T00:00:00.000Z",
    type: "event.publish",
    payload: {
      executionGrant: createExecutionGrant(id(index, 5), id(index, 4), 1),
      event: {
        schemaVersion: 1,
        eventId: id(index, 6),
        sessionId: `session-${String(index)}`,
        turnId: id(index, 7),
        agentId: "root",
        seq: 1,
        occurredAt: "2026-08-25T00:00:00.000Z",
        type: "assistant.text.delta",
        payload: { text: "hello" },
      },
    },
  });
  if (message.type !== "event.publish") throw new Error("Invalid test publication");
  return message;
}

describe("JetStreamAgentEventIngestor", () => {
  it("validates concurrent Session events in one authority batch while ACKing each PubAck", async () => {
    const messages = Array.from({ length: 64 }, (_, index) => publication(index + 1));
    const appendGroup = vi.fn(async () => undefined);
    const commitAcceptedMany = vi.fn(
      async (input: readonly EventPublishMessage[], durableCommit: AgentEventDurableCommit) => {
        const accepted = input.map((message) => ({
          schemaVersion: 2 as const,
          tenantId: id(999, 1),
          events: [message.payload.event],
        }));
        await durableCommit(accepted);
        return { accepted, duplicates: [], rejected: [] };
      },
    );
    const ingestor = new JetStreamAgentEventIngestor({
      authority: { commitAcceptedMany },
      publisher: { appendGroup, checkHealth: async () => undefined },
    });
    const acknowledgements = await Promise.all(messages.map((message) => ingestor.ingest(message)));
    expect(commitAcceptedMany).toHaveBeenCalledTimes(1);
    expect(commitAcceptedMany.mock.calls[0]![0]).toHaveLength(64);
    expect(appendGroup).toHaveBeenCalledTimes(1);
    expect(acknowledgements.map((ack) => ack.payload.acknowledgedThroughSeq)).toEqual(
      Array.from({ length: 64 }, () => 1),
    );
    expect(ingestor.statistics()).toEqual({ batches: 1, events: 64, maximumBatchSize: 64 });
    await ingestor.close();
  });

  it("rejects a stale authority result without publishing it", async () => {
    const message = publication(1);
    const appendGroup = vi.fn(async () => undefined);
    const ingestor = new JetStreamAgentEventIngestor({
      authority: {
        commitAcceptedMany: async () => ({
          accepted: [],
          duplicates: [],
          rejected: [message],
        }),
      },
      publisher: { appendGroup, checkHealth: async () => undefined },
    });
    await expect(ingestor.ingest(message)).rejects.toMatchObject({
      code: "stale_execution_grant",
    });
    expect(appendGroup).not.toHaveBeenCalled();
    await ingestor.close();
  });
});

describe("HttpAgentEventIngestor", () => {
  it("retries the same publication through a temporary ingest outage", async () => {
    const message = publication(1);
    const ack = parseControlToSupervisorMessage({
      protocolVersion: 1,
      messageId: id(1, 8),
      sentAt: "2026-08-25T00:00:00.000Z",
      type: "event.ack",
      payload: {
        sessionId: message.payload.event.sessionId,
        executionGrant: message.payload.executionGrant,
        acknowledgedThroughSeq: message.payload.event.seq,
      },
    });
    const originalFetch = globalThis.fetch;
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response('{"error":"temporary"}', { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(ack), { status: 200 }));
    globalThis.fetch = fetchMock;
    try {
      const ingestor = new HttpAgentEventIngestor({
        baseUrl: "http://control-plane.internal:8080",
        serviceToken: "a".repeat(32),
        allowInsecureHttp: true,
      });
      await expect(ingestor.ingest(message)).resolves.toMatchObject({ type: "event.ack" });
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0]![1]?.body).toBe(fetchMock.mock.calls[1]![1]?.body);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
