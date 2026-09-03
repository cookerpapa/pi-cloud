import fastifyWebsocket from "@fastify/websocket";
import {
  createExecutionLease,
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
} from "@pi-cloud/protocol";
import { WebSocketAcceptedFactIngestor } from "@pi-cloud/runtime-core/accepted-fact-channel";
import { DurableEventStoreError } from "@pi-cloud/runtime-core/durable-event-store";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AcceptedFactIngestGateway,
  type FactChannelServicePort,
} from "../src/accepted-fact-ingest-gateway.ts";

const TOKEN = "w".repeat(48);
const GRANT = createExecutionLease(
  "20000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-000000000002",
  1,
);
const SECOND_GRANT = createExecutionLease(
  "30000000-0000-4000-8000-000000000001",
  "30000000-0000-4000-8000-000000000002",
  2,
);
const FAILED_GRANT = createExecutionLease(
  "40000000-0000-4000-8000-000000000001",
  "40000000-0000-4000-8000-000000000002",
  3,
);
const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

describe("AcceptedFactIngestGateway", () => {
  it("authenticates and multiplexes isolated Fact Streams", async () => {
    const closedLeases: string[] = [];
    const channels: FactChannelServicePort = {
      checkHealth: async () => undefined,
      statistics: () => ({ activeChannels: 0 }),
      open: async (message) => {
        let acknowledgedThroughSeq = 0;
        return {
          executionLease: message.payload.executionLease,
          sessionId: message.payload.sessionId,
          turnId: message.payload.turnId,
          get acknowledgedThroughSeq() {
            return acknowledgedThroughSeq;
          },
          leaseDurationMs: 9_000,
          ingest: async (value) => {
            const event = parseSupervisorToControlMessage(value);
            if (event.type !== "event.publish") throw new Error("Expected event publication");
            if (message.payload.sessionId === "session-failed") {
              throw new DurableEventStoreError(
                "stale_session_lease",
                "Fixture Fact Stream authority expired",
                false,
              );
            }
            acknowledgedThroughSeq = event.payload.event.seq;
            const ack = parseControlToSupervisorMessage({
              protocolVersion: 1,
              messageId: "20000000-0000-4000-8000-000000000003",
              sentAt: "2026-08-26T00:00:00.000Z",
              type: "event.ack",
              payload: {
                sessionId: event.payload.event.sessionId,
                executionLease: event.payload.executionLease,
                acknowledgedThroughSeq,
              },
            });
            if (ack.type !== "event.ack") throw new Error("Invalid ACK fixture");
            return ack;
          },
          mutate: async (mutation) => ({ mutationId: mutation.mutationId, accepted: true }),
          close: vi.fn(async () => {
            closedLeases.push(message.payload.executionLease);
          }),
        };
      },
    };
    const server = Fastify({ logger: false });
    await server.register(fastifyWebsocket, { options: { perMessageDeflate: false } });
    new AcceptedFactIngestGateway({ channels, serviceToken: TOKEN }).install(server);
    await server.listen({ host: "127.0.0.1", port: 0 });
    resources.push(async () => server.close());
    const address = server.server.address();
    if (address === null || typeof address === "string") throw new Error("Gateway did not bind");
    const baseUrl = `http://127.0.0.1:${String(address.port)}`;

    await expect(
      fetch(`${baseUrl}/internal/v1/accepted-facts/health`, {
        headers: { authorization: `Bearer ${"x".repeat(48)}` },
      }),
    ).resolves.toMatchObject({ status: 401 });

    const client = new WebSocketAcceptedFactIngestor({
      baseUrl,
      serviceToken: TOKEN,
      allowInsecureHttp: true,
    });
    await client.checkHealth();
    const channel = await client.open({
      executionLease: GRANT,
      sessionId: "session-1",
      piSession: { id: "session-1", lane: "main" },
      turnId: "turn-1",
      nextEventSeq: 1,
    });
    const second = await client.open({
      executionLease: SECOND_GRANT,
      sessionId: "session-2",
      piSession: { id: "session-2", lane: "main" },
      turnId: "turn-2",
      nextEventSeq: 1,
    });
    const failed = await client.open({
      executionLease: FAILED_GRANT,
      sessionId: "session-failed",
      piSession: { id: "session-failed", lane: "main" },
      turnId: "turn-failed",
      nextEventSeq: 1,
    });
    const health = await fetch(`${baseUrl}/internal/v1/accepted-facts/health`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    await expect(health.json()).resolves.toMatchObject({ status: "ready", activeConnections: 1 });
    const event = parseSupervisorToControlMessage({
      protocolVersion: 1,
      messageId: "20000000-0000-4000-8000-000000000004",
      sentAt: "2026-08-26T00:00:00.000Z",
      type: "event.publish",
      payload: {
        executionLease: GRANT,
        event: {
          schemaVersion: 1,
          eventId: "20000000-0000-4000-8000-000000000005",
          sessionId: "session-1",
          turnId: "turn-1",
          agentId: "root",
          seq: 1,
          occurredAt: "2026-08-26T00:00:00.000Z",
          type: "assistant.text.delta",
          payload: { text: "hello" },
        },
      },
    });
    await expect(channel.ingest(event)).resolves.toMatchObject({
      type: "event.ack",
      payload: { acknowledgedThroughSeq: 1 },
    });
    const failedEvent = parseSupervisorToControlMessage({
      protocolVersion: 1,
      messageId: "40000000-0000-4000-8000-000000000004",
      sentAt: "2026-08-26T00:00:00.000Z",
      type: "event.publish",
      payload: {
        executionLease: FAILED_GRANT,
        event: {
          schemaVersion: 1,
          eventId: "40000000-0000-4000-8000-000000000005",
          sessionId: "session-failed",
          turnId: "turn-failed",
          agentId: "root",
          seq: 1,
          occurredAt: "2026-08-26T00:00:00.000Z",
          type: "assistant.text.delta",
          payload: { text: "rejected" },
        },
      },
    });
    await expect(failed.ingest(failedEvent)).rejects.toMatchObject({
      code: "stale_session_lease",
      retryable: false,
    });
    await channel.close();
    expect(closedLeases.sort()).toEqual([FAILED_GRANT, GRANT].sort());
    await second.close();
    expect(closedLeases.sort()).toEqual([FAILED_GRANT, GRANT, SECOND_GRANT].sort());
    await client.close();
  }, 40_000);
});
