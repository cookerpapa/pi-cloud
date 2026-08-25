import {
  PI_SESSION_MUTATION_INGEST_PATH,
  PiSessionMutationIngestError,
  type JetStreamPiSessionMutationIngestor,
} from "@pi-cloud/runtime-core/jetstream-pi-session-mutations";
import type { FastifyInstance, FastifyRequest } from "fastify";

export class PiSessionMutationIngestGateway {
  readonly #ingestor: Pick<JetStreamPiSessionMutationIngestor, "ingest" | "checkHealth">;
  readonly #authorization: string;
  #installed = false;

  constructor(options: {
    ingestor: Pick<JetStreamPiSessionMutationIngestor, "ingest" | "checkHealth">;
    serviceToken: string;
  }) {
    if (!/^[A-Za-z0-9._~+/=-]{32,4096}$/u.test(options.serviceToken)) {
      throw new TypeError("Pi Session Mutation Ingest service token is invalid");
    }
    this.#ingestor = options.ingestor;
    this.#authorization = `Bearer ${options.serviceToken}`;
  }

  install(fastify: FastifyInstance): void {
    if (this.#installed) throw new Error("Pi Session Mutation Ingest gateway is already installed");
    this.#installed = true;
    fastify.get(`${PI_SESSION_MUTATION_INGEST_PATH}/health`, async (request, reply) => {
      if (!this.#authorized(request)) {
        await reply.code(401).send({ error: "authentication_required" });
        return;
      }
      try {
        await this.#ingestor.checkHealth();
        await reply.code(200).send({ status: "ready" });
      } catch {
        await reply.code(503).send({ status: "not_ready" });
      }
    });
    fastify.post(
      PI_SESSION_MUTATION_INGEST_PATH,
      { bodyLimit: 16 * 1024 * 1024 },
      async (request, reply) => {
        if (!this.#authorized(request)) {
          await reply.code(401).send({ error: "authentication_required" });
          return;
        }
        try {
          await reply.code(200).send(await this.#ingestor.ingest(request.body));
        } catch (error: unknown) {
          if (error instanceof PiSessionMutationIngestError) {
            const status =
              error.code === "stale_execution_grant"
                ? 409
                : error.code === "invalid_mutation"
                  ? 400
                  : 503;
            await reply.code(status).send({ error: error.code });
            return;
          }
          request.log.warn({ err: error }, "Pi Session Mutation Ingest failed");
          await reply.code(503).send({ error: "mutation_ingest_unavailable" });
        }
      },
    );
  }

  #authorized(request: FastifyRequest): boolean {
    return request.headers.authorization === this.#authorization;
  }
}
