import {
  AGENT_EVENT_INGEST_PATH,
  type JetStreamAgentEventIngestor,
} from "@pi-cloud/runtime-core/jetstream-agent-event-log";
import type { FastifyInstance, FastifyRequest } from "fastify";

export class AgentEventIngestGateway {
  readonly #ingestor: JetStreamAgentEventIngestor;
  readonly #authorization: string;
  #installed = false;

  constructor(options: { ingestor: JetStreamAgentEventIngestor; serviceToken: string }) {
    if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/u.test(options.serviceToken)) {
      throw new TypeError("Agent event ingest service token is invalid");
    }
    this.#ingestor = options.ingestor;
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
        await this.#ingestor.checkHealth();
        await reply.code(200).send({ status: "ready", ...this.#ingestor.statistics() });
      } catch {
        await reply.code(503).send({ status: "not_ready" });
      }
    });
    fastify.post(AGENT_EVENT_INGEST_PATH, async (request, reply) => {
      if (!this.#authorized(request)) {
        await reply.code(401).send({ error: "authentication_required" });
        return;
      }
      try {
        await reply.code(200).send(await this.#ingestor.ingest(request.body));
      } catch (error: unknown) {
        if (
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "stale_fence"
        ) {
          await reply.code(409).send({ error: "stale_fence" });
          return;
        }
        request.log.warn({ err: error }, "Agent event ingest failed");
        await reply.code(503).send({ error: "event_ingest_unavailable" });
      }
    });
  }

  #authorized(request: FastifyRequest): boolean {
    return request.headers.authorization === this.#authorization;
  }
}
