import {
  createExecutionGrant,
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
  type EventPublishMessage,
} from "@pi-cloud/protocol";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { WebSocketAgentEventIngestor } from "../src/jetstream-agent-event-log.ts";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

function id(index: number, suffix: number): string {
  return `${String(index).padStart(8, "0")}-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
}

function publication(index: number): EventPublishMessage {
  const message = parseSupervisorToControlMessage({
    protocolVersion: 1,
    messageId: id(index, 1),
    sentAt: "2026-08-26T00:00:00.000Z",
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
        occurredAt: "2026-08-26T00:00:00.000Z",
        type: "assistant.text.delta",
        payload: { text: "hello" },
      },
    },
  });
  if (message.type !== "event.publish") throw new Error("Invalid test publication");
  return message;
}

async function startServer(
  onMessage: (
    value: ReturnType<typeof parseSupervisorToControlMessage>,
    send: (value: unknown) => void,
  ) => void,
): Promise<string> {
  const server = createServer();
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (request.headers.authorization !== `Bearer ${"a".repeat(32)}`) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client));
  });
  sockets.on("connection", (client) => {
    client.on("message", (data) => {
      const value = parseSupervisorToControlMessage(JSON.parse(data.toString("utf8")));
      onMessage(value, (response) => client.send(JSON.stringify(response)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Test server did not bind");
  resources.push(async () => {
    for (const client of sockets.clients) client.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
  return `http://127.0.0.1:${String(address.port)}`;
}

describe("WebSocketAgentEventIngestor", () => {
  it("opens one Grant channel, ACKs a durable event and confirms close", async () => {
    const event = publication(1);
    const baseUrl = await startServer((message, send) => {
      if (message.type === "event.writer.open") {
        send(
          parseControlToSupervisorMessage({
            protocolVersion: 1,
            messageId: id(10, 1),
            sentAt: "2026-08-26T00:00:00.000Z",
            type: "event.writer.ready",
            payload: {
              acknowledgedMessageId: message.messageId,
              executionGrant: message.payload.executionGrant,
              sessionId: message.payload.sessionId,
              turnId: message.payload.turnId,
              acknowledgedThroughSeq: 0,
              leaseDurationMs: 9_000,
            },
          }),
        );
      } else if (message.type === "event.publish") {
        send(
          parseControlToSupervisorMessage({
            protocolVersion: 1,
            messageId: id(10, 2),
            sentAt: "2026-08-26T00:00:00.000Z",
            type: "event.ack",
            payload: {
              sessionId: message.payload.event.sessionId,
              executionGrant: message.payload.executionGrant,
              acknowledgedThroughSeq: message.payload.event.seq,
            },
          }),
        );
      } else if (message.type === "event.writer.close") {
        send(
          parseControlToSupervisorMessage({
            protocolVersion: 1,
            messageId: id(10, 3),
            sentAt: "2026-08-26T00:00:00.000Z",
            type: "event.writer.closed",
            payload: {
              acknowledgedMessageId: message.messageId,
              executionGrant: message.payload.executionGrant,
              acknowledgedThroughSeq: message.payload.acknowledgedThroughSeq,
            },
          }),
        );
      }
    });
    const ingestor = new WebSocketAgentEventIngestor({
      baseUrl,
      serviceToken: "a".repeat(32),
      allowInsecureHttp: true,
    });
    const writer = await ingestor.open({
      executionGrant: event.payload.executionGrant,
      sessionId: event.payload.event.sessionId,
      turnId: event.payload.event.turnId!,
      nextEventSeq: 1,
    });
    await expect(writer.ingest(event)).resolves.toMatchObject({
      type: "event.ack",
      payload: { acknowledgedThroughSeq: 1 },
    });
    expect(writer.acknowledgedThroughSeq).toBe(1);
    await writer.close();
    await ingestor.close();
  });
});
