import fastifyWebsocket from "@fastify/websocket";
import {
  createExecutionGrant,
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
} from "@pi-cloud/protocol";
import { WebSocketAcceptedFactIngestor } from "@pi-cloud/runtime-core/jetstream-agent-event-log";
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AcceptedFactIngestGateway,
  type FactChannelServicePort,
} from "../src/accepted-fact-ingest-gateway.ts";

const TOKEN = "w".repeat(48);
const GRANT = createExecutionGrant(
  "20000000-0000-4000-8000-000000000001",
  "20000000-0000-4000-8000-000000000002",
  1,
);
const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

describe("AcceptedFactIngestGateway", () => {
  it("authenticates and isolates one FactChannel", async () => {
    let acknowledgedThroughSeq = 0;
    const close = vi.fn(async () => undefined);
    const channels: FactChannelServicePort = {
      checkHealth: async () => undefined,
      statistics: () => ({ activeChannels: 0 }),
      open: async (message) => ({
        executionGrant: message.payload.executionGrant,
        sessionId: message.payload.sessionId,
        turnId: message.payload.turnId,
        get acknowledgedThroughSeq() {
          return acknowledgedThroughSeq;
        },
        leaseDurationMs: 9_000,
        ingest: async (value) => {
          const event = parseSupervisorToControlMessage(value);
          if (event.type !== "event.publish") throw new Error("Expected event publication");
          acknowledgedThroughSeq = event.payload.event.seq;
          const ack = parseControlToSupervisorMessage({
            protocolVersion: 1,
            messageId: "20000000-0000-4000-8000-000000000003",
            sentAt: "2026-08-26T00:00:00.000Z",
            type: "event.ack",
            payload: {
              sessionId: event.payload.event.sessionId,
              executionGrant: event.payload.executionGrant,
              acknowledgedThroughSeq,
            },
          });
          if (ack.type !== "event.ack") throw new Error("Invalid ACK fixture");
          return ack;
        },
        mutate: async (mutation) => ({ mutationId: mutation.mutationId, accepted: true }),
        close,
      }),
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
      executionGrant: GRANT,
      sessionId: "session-1",
      turnId: "turn-1",
      nextEventSeq: 1,
    });
    const event = parseSupervisorToControlMessage({
      protocolVersion: 1,
      messageId: "20000000-0000-4000-8000-000000000004",
      sentAt: "2026-08-26T00:00:00.000Z",
      type: "event.publish",
      payload: {
        executionGrant: GRANT,
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
    await channel.close();
    expect(close).toHaveBeenCalledTimes(1);
    await client.close();
  }, 40_000);
});
