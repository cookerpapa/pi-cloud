import {
  ACCEPTED_FACT_INGEST_PATH,
  FACT_CHANNEL_PATH,
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

const MAXIMUM_PENDING_FRAMES = 8;

type ChannelContext = {
  socket: WebSocket;
  connectionId: string;
  channel: AcceptedFactChannelSession | undefined;
  pendingFrames: number;
  processing: Promise<void>;
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

function send(socket: WebSocket, value: unknown): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    socket.send(JSON.stringify(value), (error) => (error == null ? resolve() : reject(error)));
  });
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (socket.readyState === socket.OPEN) socket.close(code, reason);
  else if (socket.readyState !== socket.CLOSED) socket.terminate();
}

export class AcceptedFactIngestGateway {
  readonly #channels: FactChannelServicePort;
  readonly #authorization: string;
  readonly #contexts = new Set<ChannelContext>();
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
        await reply.code(200).send({ status: "ready", ...this.#channels.statistics() });
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
    const context: ChannelContext = {
      socket,
      connectionId: globalThis.crypto.randomUUID(),
      channel: undefined,
      pendingFrames: 0,
      processing: Promise.resolve(),
      closed: false,
    };
    this.#contexts.add(context);
    socket.on("message", (data, isBinary) => {
      if (context.closed) return;
      context.pendingFrames += 1;
      if (context.pendingFrames > MAXIMUM_PENDING_FRAMES) {
        context.pendingFrames -= 1;
        this.#close(context, 1_013, "FactChannel overloaded");
        return;
      }
      context.processing = context.processing
        .then(async () => {
          if (!context.closed) await this.#process(context, data, isBinary);
        })
        .catch((error: unknown) => {
          const code =
            typeof error === "object" &&
            error !== null &&
            "code" in error &&
            error.code === "stale_session_lease"
              ? 1_008
              : 1_011;
          this.#close(context, code, "FactChannel failed");
        })
        .finally(() => {
          context.pendingFrames -= 1;
        });
    });
    socket.once("close", () => this.#cleanup(context));
    socket.once("error", () => this.#close(context, 1_011, "FactChannel transport failed"));
  }

  async #process(context: ChannelContext, data: RawData, isBinary: boolean): Promise<void> {
    if (isBinary) {
      this.#close(context, 1_003, "binary FactChannel frames unsupported");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(textFrame(data));
    } catch {
      this.#close(context, 1_002, "invalid FactChannel json");
      return;
    }
    if (
      typeof value === "object" &&
      value !== null &&
      (value as { type?: unknown }).type === "fact.pi_session_mutation.publish"
    ) {
      if (context.channel === undefined) {
        this.#close(context, 1_002, "FactChannel must open first");
        return;
      }
      const frame = value as {
        messageId: string;
        payload: CandidatePiSessionMutationFact;
      };
      const accepted = await context.channel.mutate(frame.payload);
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
      await send(context.socket, acknowledgement);
      return;
    }
    const message = parseSupervisorToControlMessage(value);
    if (context.channel === undefined) {
      if (message.type !== "fact.channel.open") {
        this.#close(context, 1_002, "FactChannel must open first");
        return;
      }
      await this.#open(context, message);
      return;
    }
    if (message.type === "event.publish") {
      await send(context.socket, await context.channel.ingest(message));
      return;
    }
    if (message.type === "fact.channel.close") {
      const channel = context.channel;
      if (
        message.payload.executionLease !== channel.executionLease ||
        message.payload.acknowledgedThroughSeq !== channel.acknowledgedThroughSeq
      ) {
        this.#close(context, 1_002, "FactChannel close watermark mismatch");
        return;
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
      await send(context.socket, closed);
      context.channel = undefined;
      this.#close(context, 1_000, "FactChannel closed");
      return;
    }
    this.#close(context, 1_002, "unexpected FactChannel frame");
  }

  async #open(context: ChannelContext, message: FactChannelOpenMessage): Promise<void> {
    context.channel = await this.#channels.open(message, context.connectionId, () => {
      this.#close(context, 1_008, "FactChannel lease expired");
    });
    const ready = parseControlToSupervisorMessage({
      protocolVersion: 1,
      messageId: globalThis.crypto.randomUUID(),
      sentAt: new Date().toISOString(),
      type: "fact.channel.ready",
      payload: {
        acknowledgedMessageId: message.messageId,
        executionLease: context.channel.executionLease,
        sessionId: context.channel.sessionId,
        turnId: context.channel.turnId,
        acknowledgedThroughSeq: context.channel.acknowledgedThroughSeq,
        leaseDurationMs: context.channel.leaseDurationMs,
      },
    });
    await send(context.socket, ready);
  }

  #close(context: ChannelContext, code: number, reason: string): void {
    if (context.closed) return;
    context.closed = true;
    closeSocket(context.socket, code, reason);
    void this.#cleanup(context);
  }

  #cleanup(context: ChannelContext): void {
    if (!this.#contexts.delete(context)) return;
    context.closed = true;
    void context.channel?.close().catch(() => undefined);
  }

  #authorized(request: FastifyRequest): boolean {
    return request.headers.authorization === this.#authorization;
  }
}
