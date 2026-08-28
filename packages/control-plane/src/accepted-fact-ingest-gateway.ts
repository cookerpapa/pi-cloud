import {
  ACCEPTED_FACT_INGEST_PATH,
  FACT_CHANNEL_PATH,
  factStreamFailureFrame,
  factTransportEnvelope,
  parseFactTransportEnvelope,
  type AcceptedFactChannelSession,
} from "@pi-cloud/runtime-core/accepted-fact-channel";
import {
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
  type FactChannelOpenMessage,
} from "@pi-cloud/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RawData, WebSocket } from "ws";
import type {
  CandidatePiSessionMutationFact,
  PiSessionMutationAcceptedFrame,
} from "@pi-cloud/runtime-core/accepted-fact";

const MAXIMUM_PENDING_CONNECTION_FRAMES = 1_024;
const MAXIMUM_PENDING_STREAM_FRAMES = 8;

type StreamContext = {
  streamId: string;
  authorityConnectionId: string;
  channel: AcceptedFactChannelSession | undefined;
  pendingFrames: number;
  processing: Promise<void>;
  closed: boolean;
};

type ConnectionContext = {
  socket: WebSocket;
  streams: Map<string, StreamContext>;
  pendingFrames: number;
  closed: boolean;
};

export interface FactChannelServicePort {
  open(
    message: FactChannelOpenMessage,
    connectionId: string,
    onFailure: (error: Error) => void,
  ): Promise<AcceptedFactChannelSession>;
  checkHealth(): Promise<void>;
  statistics(): Readonly<Record<string, number>>;
}

function textFrame(data: RawData): string {
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return data.toString("utf8");
}

function send(socket: WebSocket, streamId: string, payload: unknown): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.send(JSON.stringify(factTransportEnvelope(streamId, payload)), (error) =>
      error == null ? resolve() : reject(error),
    );
  });
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === socket.OPEN) socket.close(code, reason);
  else if (socket.readyState !== socket.CLOSED) socket.terminate();
}

export class AcceptedFactIngestGateway {
  readonly #channels: FactChannelServicePort;
  readonly #authorization: string;
  readonly #contexts = new Set<ConnectionContext>();
  #installed = false;

  constructor(options: { channels: FactChannelServicePort; serviceToken: string }) {
    if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/u.test(options.serviceToken)) {
      throw new TypeError("Agent event ingest service token is invalid");
    }
    this.#channels = options.channels;
    this.#authorization = `Bearer ${options.serviceToken}`;
  }

  install(fastify: FastifyInstance): void {
    if (this.#installed) throw new Error("Agent event ingest gateway is already installed");
    this.#installed = true;
    fastify.get(`${ACCEPTED_FACT_INGEST_PATH}/health`, async (request, reply) => {
      if (!this.#authorized(request)) {
        await reply.code(401).send({ error: "authentication_required" });
        return;
      }
      try {
        await this.#channels.checkHealth();
        await reply.code(200).send({
          status: "ready",
          ...this.#channels.statistics(),
          activeConnections: this.#contexts.size,
        });
      } catch {
        await reply.code(503).send({ status: "not_ready" });
      }
    });
    fastify.register(async (scope) => {
      scope.addHook("preValidation", async (request, reply) => {
        if (!this.#authorized(request)) await reply.code(401).send();
      });
      scope.get(FACT_CHANNEL_PATH, { websocket: true }, (socket) => {
        this.#accept(socket);
      });
    });
  }

  #accept(socket: WebSocket): void {
    const context: ConnectionContext = {
      socket,
      streams: new Map(),
      pendingFrames: 0,
      closed: false,
    };
    this.#contexts.add(context);
    socket.on("message", (data, isBinary) => {
      if (context.closed) return;
      if (isBinary) {
        this.#closeConnection(context, 1_003, "binary Fact frames unsupported");
        return;
      }
      let envelope;
      try {
        envelope = parseFactTransportEnvelope(JSON.parse(textFrame(data)));
      } catch {
        this.#closeConnection(context, 1_002, "invalid multiplexed Fact frame");
        return;
      }
      let stream = context.streams.get(envelope.streamId);
      if (stream === undefined) {
        stream = {
          streamId: envelope.streamId,
          authorityConnectionId: globalThis.crypto.randomUUID(),
          channel: undefined,
          pendingFrames: 0,
          processing: Promise.resolve(),
          closed: false,
        };
        context.streams.set(envelope.streamId, stream);
      }
      context.pendingFrames += 1;
      stream.pendingFrames += 1;
      if (
        context.pendingFrames > MAXIMUM_PENDING_CONNECTION_FRAMES ||
        stream.pendingFrames > MAXIMUM_PENDING_STREAM_FRAMES
      ) {
        context.pendingFrames -= 1;
        stream.pendingFrames -= 1;
        this.#failStream(context, stream, new Error("Fact Stream overloaded"));
        return;
      }
      const activeStream = stream;
      stream.processing = stream.processing
        .then(async () => {
          if (!context.closed && !activeStream.closed) {
            await this.#process(context, activeStream, envelope.payload);
          }
        })
        .catch((error: unknown) => this.#failStream(context, activeStream, error))
        .finally(() => {
          context.pendingFrames -= 1;
          activeStream.pendingFrames -= 1;
        });
    });
    socket.once("close", () => this.#cleanup(context));
    socket.once("error", () =>
      this.#closeConnection(context, 1_011, "Worker Fact connection failed"),
    );
  }

  async #process(context: ConnectionContext, stream: StreamContext, value: unknown): Promise<void> {
    if (
      typeof value === "object" &&
      value !== null &&
      (value as { type?: unknown }).type === "fact.pi_session_mutation.publish"
    ) {
      if (stream.channel === undefined) throw new Error("Fact Stream must open first");
      const frame = value as { messageId: string; payload: CandidatePiSessionMutationFact };
      const accepted = await stream.channel.mutate(frame.payload);
      const acknowledgement: PiSessionMutationAcceptedFrame = {
        protocolVersion: 1,
        messageId: globalThis.crypto.randomUUID(),
        sentAt: new Date().toISOString(),
        type: "fact.pi_session_mutation.accepted",
        payload: {
          acknowledgedMessageId: frame.messageId,
          mutationId: accepted.mutationId,
          accepted: true,
        },
      };
      await send(context.socket, stream.streamId, acknowledgement);
      return;
    }
    const message = parseSupervisorToControlMessage(value);
    if (stream.channel === undefined) {
      if (message.type !== "fact.channel.open") throw new Error("Fact Stream must open first");
      await this.#open(context, stream, message);
      return;
    }
    if (message.type === "event.publish") {
      await send(context.socket, stream.streamId, await stream.channel.ingest(message));
      return;
    }
    if (message.type === "fact.channel.close") {
      const channel = stream.channel;
      if (
        message.payload.executionLease !== channel.executionLease ||
        message.payload.acknowledgedThroughSeq !== channel.acknowledgedThroughSeq
      ) {
        throw new Error("Fact Stream close watermark mismatch");
      }
      await channel.close();
      const closed = parseControlToSupervisorMessage({
        protocolVersion: 1,
        messageId: globalThis.crypto.randomUUID(),
        sentAt: new Date().toISOString(),
        type: "fact.channel.closed",
        payload: {
          acknowledgedMessageId: message.messageId,
          executionLease: channel.executionLease,
          acknowledgedThroughSeq: channel.acknowledgedThroughSeq,
        },
      });
      await send(context.socket, stream.streamId, closed);
      this.#removeStream(context, stream);
      return;
    }
    throw new Error("Unexpected Fact Stream frame");
  }

  async #open(
    context: ConnectionContext,
    stream: StreamContext,
    message: FactChannelOpenMessage,
  ): Promise<void> {
    stream.channel = await this.#channels.open(message, stream.authorityConnectionId, (error) => {
      this.#failStream(context, stream, error);
    });
    const ready = parseControlToSupervisorMessage({
      protocolVersion: 1,
      messageId: globalThis.crypto.randomUUID(),
      sentAt: new Date().toISOString(),
      type: "fact.channel.ready",
      payload: {
        acknowledgedMessageId: message.messageId,
        executionLease: stream.channel.executionLease,
        sessionId: stream.channel.sessionId,
        turnId: stream.channel.turnId,
        acknowledgedThroughSeq: stream.channel.acknowledgedThroughSeq,
        leaseDurationMs: stream.channel.leaseDurationMs,
      },
    });
    await send(context.socket, stream.streamId, ready);
  }

  #failStream(context: ConnectionContext, stream: StreamContext, error: unknown): void {
    if (stream.closed) return;
    const channel = stream.channel;
    this.#removeStream(context, stream);
    void channel?.close().catch(() => undefined);
    if (context.socket.readyState === context.socket.OPEN) {
      void send(context.socket, stream.streamId, factStreamFailureFrame(error)).catch(() => {
        this.#closeConnection(context, 1_011, "Worker Fact connection send failed");
      });
    }
  }

  #removeStream(context: ConnectionContext, stream: StreamContext): void {
    stream.closed = true;
    stream.channel = undefined;
    context.streams.delete(stream.streamId);
  }

  #closeConnection(context: ConnectionContext, code: number, reason: string): void {
    if (context.closed) return;
    context.closed = true;
    closeSocket(context.socket, code, reason);
    this.#cleanup(context);
  }

  #cleanup(context: ConnectionContext): void {
    if (!this.#contexts.delete(context)) return;
    context.closed = true;
    const streams = [...context.streams.values()];
    context.streams.clear();
    for (const stream of streams) {
      stream.closed = true;
      void stream.channel?.close().catch(() => undefined);
    }
  }

  #authorized(request: FastifyRequest): boolean {
    return request.headers.authorization === this.#authorization;
  }
}
