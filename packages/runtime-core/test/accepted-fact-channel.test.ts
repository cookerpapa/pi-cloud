import {
  createExecutionLease,
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
  type EventPublishMessage,
} from "@pi-cloud/protocol";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import {
  WebSocketAcceptedFactIngestor,
  factTransportEnvelope,
  parseFactTransportEnvelope,
} from "../src/accepted-fact-channel.ts";
import type { PiSessionMutationPublishFrame } from "../src/accepted-fact.ts";

type WorkerFactFrame =
  ReturnType<typeof parseSupervisorToControlMessage> | PiSessionMutationPublishFrame;

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

function id(index: number, suffix: number): string {
  return `${String(index).padStart(8, "0")}-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
}

function publication(index: number, sequence = 1): EventPublishMessage {
  const message = parseSupervisorToControlMessage({
    protocolVersion: 1,
    messageId: id(index, sequence),
    sentAt: "2026-08-26T00:00:00.000Z",
    type: "event.publish",
    payload: {
      executionLease: createExecutionLease(id(index, 5), id(index, 4), 1),
      event: {
        schemaVersion: 1,
        eventId: id(index, 5 + sequence),
        sessionId: `session-${String(index)}`,
        turnId: id(index, 7),
        agentId: "root",
        seq: sequence,
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
  onMessage: (value: WorkerFactFrame, send: (value: unknown) => void) => void,
): Promise<
  Readonly<{ baseUrl: string; connectionCount: () => number; disconnectAll: () => void }>
> {
  const server = createServer();
  const sockets = new WebSocketServer({ noServer: true });
  let connectionCount = 0;
  server.on("upgrade", (request, socket, head) => {
    if (request.headers.authorization !== `Bearer ${"a".repeat(32)}`) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) => sockets.emit("connection", client));
  });
  sockets.on("connection", (client) => {
    connectionCount += 1;
    client.on("message", (data) => {
      const envelope = parseFactTransportEnvelope(JSON.parse(data.toString("utf8")));
      const candidate = envelope.payload as WorkerFactFrame;
      const value =
        candidate.type === "fact.pi_session_mutation.publish"
          ? candidate
          : parseSupervisorToControlMessage(candidate);
      onMessage(value, (response) =>
        client.send(JSON.stringify(factTransportEnvelope(envelope.streamId, response))),
      );
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
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    connectionCount: () => connectionCount,
    disconnectAll: () => {
      for (const client of sockets.clients) client.terminate();
    },
  };
}

function respondToFact(message: WorkerFactFrame, send: (value: unknown) => void): void {
  if (message.type === "fact.channel.open") {
    send(
      parseControlToSupervisorMessage({
        protocolVersion: 1,
        messageId: id(10, 1),
        sentAt: "2026-08-26T00:00:00.000Z",
        type: "fact.channel.ready",
        payload: {
          acknowledgedMessageId: message.messageId,
          executionLease: message.payload.executionLease,
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
          executionLease: message.payload.executionLease,
          acknowledgedThroughSeq: message.payload.event.seq,
        },
      }),
    );
  } else if (message.type === "fact.channel.close") {
    send(
      parseControlToSupervisorMessage({
        protocolVersion: 1,
        messageId: id(10, 3),
        sentAt: "2026-08-26T00:00:00.000Z",
        type: "fact.channel.closed",
        payload: {
          acknowledgedMessageId: message.messageId,
          executionLease: message.payload.executionLease,
          acknowledgedThroughSeq: message.payload.acknowledgedThroughSeq,
        },
      }),
    );
  } else if (message.type === "fact.pi_session_mutation.publish") {
    send({
      protocolVersion: 1,
      messageId: id(10, 4),
      sentAt: "2026-08-26T00:00:00.000Z",
      type: "fact.pi_session_mutation.accepted",
      payload: {
        acknowledgedMessageId: message.messageId,
        mutationId: message.payload.mutationId,
        accepted: true,
      },
    });
  }
}

describe("WebSocketAcceptedFactIngestor", () => {
  it("opens one ExecutionLease channel, ACKs a durable event and confirms close", async () => {
    const event = publication(1);
    const server = await startServer(respondToFact);
    const ingestor = new WebSocketAcceptedFactIngestor({
      baseUrl: server.baseUrl,
      serviceToken: "a".repeat(32),
      allowInsecureHttp: true,
    });
    const writer = await ingestor.open({
      executionLease: event.payload.executionLease,
      sessionId: event.payload.event.sessionId,
      turnId: event.payload.event.turnId!,
      nextEventSeq: 1,
    });
    await expect(writer.ingest(event)).resolves.toMatchObject({
      type: "event.ack",
      payload: { acknowledgedThroughSeq: 1 },
    });
    expect(writer.acknowledgedThroughSeq).toBe(1);
    await expect(
      ingestor.resolve(event.payload.executionLease)?.mutate({
        schemaVersion: 1,
        mutationId: id(1, 9),
        scope: {
          tenantId: id(1, 10),
          sessionId: event.payload.event.sessionId,
          turnId: event.payload.event.turnId!,
          runId: id(1, 11),
          executionLease: event.payload.executionLease,
        },
        operation: { kind: "projection_barrier" },
        occurredAt: "2026-08-26T00:00:00.000Z",
      }),
    ).resolves.toEqual({ mutationId: id(1, 9), accepted: true });
    await writer.close();
    expect(server.connectionCount()).toBe(1);
    await ingestor.close();
  });

  it("multiplexes concurrent Run streams over one Worker WebSocket", async () => {
    const server = await startServer(respondToFact);
    const ingestor = new WebSocketAcceptedFactIngestor({
      baseUrl: server.baseUrl,
      serviceToken: "a".repeat(32),
      allowInsecureHttp: true,
    });
    const firstEvent = publication(21);
    const secondEvent = publication(22);
    const [first, second] = await Promise.all([
      ingestor.open({
        executionLease: firstEvent.payload.executionLease,
        sessionId: firstEvent.payload.event.sessionId,
        turnId: firstEvent.payload.event.turnId!,
        nextEventSeq: 1,
      }),
      ingestor.open({
        executionLease: secondEvent.payload.executionLease,
        sessionId: secondEvent.payload.event.sessionId,
        turnId: secondEvent.payload.event.turnId!,
        nextEventSeq: 1,
      }),
    ]);

    await Promise.all([first.ingest(firstEvent), second.ingest(secondEvent)]);
    await first.close();
    await expect(
      ingestor.resolve(secondEvent.payload.executionLease)?.mutate({
        schemaVersion: 1,
        mutationId: id(22, 9),
        scope: {
          tenantId: id(22, 10),
          sessionId: secondEvent.payload.event.sessionId,
          turnId: secondEvent.payload.event.turnId!,
          runId: id(22, 11),
          executionLease: secondEvent.payload.executionLease,
        },
        operation: { kind: "projection_barrier" },
        occurredAt: "2026-08-26T00:00:00.000Z",
      }),
    ).resolves.toEqual({ mutationId: id(22, 9), accepted: true });
    await second.close();

    expect(server.connectionCount()).toBe(1);
    await ingestor.close();
  });

  it("reopens every logical Run stream after the shared Worker socket reconnects", async () => {
    const server = await startServer(respondToFact);
    const ingestor = new WebSocketAcceptedFactIngestor({
      baseUrl: server.baseUrl,
      serviceToken: "a".repeat(32),
      allowInsecureHttp: true,
    });
    const firstOne = publication(31);
    const firstTwo = publication(32);
    const [first, second] = await Promise.all([
      ingestor.open({
        executionLease: firstOne.payload.executionLease,
        sessionId: firstOne.payload.event.sessionId,
        turnId: firstOne.payload.event.turnId!,
        nextEventSeq: 1,
      }),
      ingestor.open({
        executionLease: firstTwo.payload.executionLease,
        sessionId: firstTwo.payload.event.sessionId,
        turnId: firstTwo.payload.event.turnId!,
        nextEventSeq: 1,
      }),
    ]);
    await Promise.all([first.ingest(firstOne), second.ingest(firstTwo)]);

    server.disconnectAll();
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    await Promise.all([first.ingest(publication(31, 2)), second.ingest(publication(32, 2))]);

    expect(server.connectionCount()).toBe(2);
    expect(first.acknowledgedThroughSeq).toBe(2);
    expect(second.acknowledgedThroughSeq).toBe(2);
    await Promise.all([first.close(), second.close()]);
    await ingestor.close();
  });
});
