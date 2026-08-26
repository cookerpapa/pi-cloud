import {
  AGENT_EVENT_INGEST_PATH,
  AGENT_EVENT_WRITER_PATH,
  type AgentEventWriterSession,
} from "@pi-cloud/runtime-core/jetstream-agent-event-log";
import {
  parseControlToSupervisorMessage,
  parseSupervisorToControlMessage,
  type EventWriterOpenMessage,
} from "@pi-cloud/protocol";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RawData, WebSocket } from "ws";

const MAXIMUM_PENDING_FRAMES = 8;

type WriterContext = {
  socket: WebSocket;
  connectionId: string;
  writer: AgentEventWriterSession | undefined;
  pendingFrames: number;
  processing: Promise<void>;
  closed: boolean;
};

export interface AgentEventWriterServicePort {
  open(
    message: EventWriterOpenMessage,
    connectionId: string,
    onFailure: (error: Error) => void,
  ): Promise<AgentEventWriterSession>;
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

export class AgentEventIngestGateway {
  readonly #writers: AgentEventWriterServicePort;
  readonly #authorization: string;
  readonly #contexts = new Set<WriterContext>();
  #installed = false;

  constructor(options: { writers: AgentEventWriterServicePort; serviceToken: string }) {
    if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/u.test(options.serviceToken)) {
      throw new TypeError("Agent event ingest service token is invalid");
    }
    this.#writers = options.writers;
    this.#authorization = `Bearer ${options.serviceToken}`;
  }

  install(fastify: FastifyInstance): void {
    if (this.#installed) throw new Error("Agent event ingest gateway is already installed");
    this.#installed = true;
    fastify.get(`${AGENT_EVENT_INGEST_PATH}/health`, async (request, reply) => {
      if (!this.#authorized(request)) {
        await reply.code(401).send({ error: "authentication_required" });
        return;
      }
      try {
        await this.#writers.checkHealth();
        await reply.code(200).send({ status: "ready", ...this.#writers.statistics() });
      } catch {
        await reply.code(503).send({ status: "not_ready" });
      }
    });
    fastify.register(async (scope) => {
      scope.addHook("preValidation", async (request, reply) => {
        if (!this.#authorized(request)) await reply.code(401).send();
      });
      scope.get(AGENT_EVENT_WRITER_PATH, { websocket: true }, (socket) => {
        this.#accept(socket);
      });
    });
  }

  #accept(socket: WebSocket): void {
    const context: WriterContext = {
      socket,
      connectionId: globalThis.crypto.randomUUID(),
      writer: undefined,
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
        this.#close(context, 1_013, "event writer overloaded");
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
            error.code === "stale_execution_grant"
              ? 1_008
              : 1_011;
          this.#close(context, code, "event writer failed");
        })
        .finally(() => {
          context.pendingFrames -= 1;
        });
    });
    socket.once("close", () => this.#cleanup(context));
    socket.once("error", () => this.#close(context, 1_011, "event writer transport failed"));
  }

  async #process(context: WriterContext, data: RawData, isBinary: boolean): Promise<void> {
    if (isBinary) {
      this.#close(context, 1_003, "binary event writer frames unsupported");
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(textFrame(data));
    } catch {
      this.#close(context, 1_002, "invalid event writer json");
      return;
    }
    const message = parseSupervisorToControlMessage(value);
    if (context.writer === undefined) {
      if (message.type !== "event.writer.open") {
        this.#close(context, 1_002, "event writer must open first");
        return;
      }
      await this.#open(context, message);
      return;
    }
    if (message.type === "event.publish") {
      await send(context.socket, await context.writer.ingest(message));
      return;
    }
    if (message.type === "event.writer.close") {
      const writer = context.writer;
      if (
        message.payload.executionGrant !== writer.executionGrant ||
        message.payload.acknowledgedThroughSeq !== writer.acknowledgedThroughSeq
      ) {
        this.#close(context, 1_002, "event writer close watermark mismatch");
        return;
      }
      await writer.close();
      const closed = parseControlToSupervisorMessage({
        protocolVersion: 1,
        messageId: globalThis.crypto.randomUUID(),
        sentAt: new Date().toISOString(),
        type: "event.writer.closed",
        payload: {
          acknowledgedMessageId: message.messageId,
          executionGrant: writer.executionGrant,
          acknowledgedThroughSeq: writer.acknowledgedThroughSeq,
        },
      });
      await send(context.socket, closed);
      context.writer = undefined;
      this.#close(context, 1_000, "event writer closed");
      return;
    }
    this.#close(context, 1_002, "unexpected event writer frame");
  }

  async #open(context: WriterContext, message: EventWriterOpenMessage): Promise<void> {
    context.writer = await this.#writers.open(message, context.connectionId, () => {
      this.#close(context, 1_008, "event writer lease expired");
    });
    const ready = parseControlToSupervisorMessage({
      protocolVersion: 1,
      messageId: globalThis.crypto.randomUUID(),
      sentAt: new Date().toISOString(),
      type: "event.writer.ready",
      payload: {
        acknowledgedMessageId: message.messageId,
        executionGrant: context.writer.executionGrant,
        sessionId: context.writer.sessionId,
        turnId: context.writer.turnId,
        acknowledgedThroughSeq: context.writer.acknowledgedThroughSeq,
        leaseDurationMs: context.writer.leaseDurationMs,
      },
    });
    await send(context.socket, ready);
  }

  #close(context: WriterContext, code: number, reason: string): void {
    if (context.closed) return;
    context.closed = true;
    closeSocket(context.socket, code, reason);
    void this.#cleanup(context);
  }

  #cleanup(context: WriterContext): void {
    if (!this.#contexts.delete(context)) return;
    context.closed = true;
    void context.writer?.close().catch(() => undefined);
  }

  #authorized(request: FastifyRequest): boolean {
    return request.headers.authorization === this.#authorization;
  }
}
