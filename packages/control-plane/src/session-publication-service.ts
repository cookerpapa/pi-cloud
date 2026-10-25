import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { MAX_EXECUTION_FACT_BYTES, parseSessionControlChange } from "@pi-cloud/protocol";
import type { SessionProjector } from "@pi-cloud/runtime-core/session-projector";
import { parseAcceptedFact } from "@pi-cloud/runtime-core/kafka-accepted-fact";
import { PUBLICATION_PATH } from "@pi-cloud/runtime-core/http-publication-client";
import { PublicationIngressRejected } from "@pi-cloud/runtime-core/session-publication-ingress";
import { PublicationNotSentError } from "@pi-cloud/protocol";
import type { ControlPlaneQuiescence } from "./control-plane-quiescence.ts";

/** Private transport of the existing control-plane publication module. */
export class SessionPublicationService {
  constructor(
    readonly token: string,
    readonly projector: Pick<
      SessionProjector,
      | "publicationAvailability"
      | "localPublicationAvailability"
      | "publicationPartition"
      | "ownerForPartition"
      | "acceptSeal"
      | "acceptControl"
    >,
    readonly quiescence?: ControlPlaneQuiescence,
  ) {}

  install(server: FastifyInstance): void {
    const digest = (value: string) => createHash("sha256").update(value).digest();
    const credential = digest(`Bearer ${this.token}`);
    const authorized = (value: string | undefined) =>
      timingSafeEqual(credential, digest(value ?? ""));
    const inflight = new Set<object>();
    server.addHook("onRequest", async (request, reply) => {
      if (!request.url.startsWith(PUBLICATION_PATH + "/")) return;
      if (!authorized(request.headers.authorization)) return reply.code(401).send();
      if (inflight.size >= 64)
        return reply
          .code(429)
          .send({ error: { code: "publication_not_sent", reason: "capacity" } });
      inflight.add(request);
      reply.raw.once("close", () => inflight.delete(request));
    });
    server.get(`${PUBLICATION_PATH}/health`, async (_request, reply) => {
      try {
        const availability = await this.projector.publicationAvailability();
        return reply.code(availability.partitions.length ? 200 : 503).send(availability);
      } catch {
        return reply.code(503).send({ ready: false });
      }
    });
    server.get(`${PUBLICATION_PATH}/health/local`, async () =>
      this.projector.localPublicationAvailability(),
    );
    if (this.quiescence) {
      const quiescence = this.quiescence;
      server.get(`${PUBLICATION_PATH}/replacement`, async () => quiescence.status());
      server.post(
        `${PUBLICATION_PATH}/replacement`,
        { bodyLimit: 1024 },
        async (request, reply) => {
          let body: { id: string; action: "prepare" | "cancel" };
          try {
            body = request.body as typeof body;
            if (
              !body ||
              typeof body.id !== "string" ||
              !/^[0-9a-f-]{36}$/.test(body.id) ||
              !["prepare", "cancel"].includes(body.action)
            )
              throw new Error("Invalid replacement request");
          } catch {
            return reply.code(400).send({ error: { code: "invalid_replacement_request" } });
          }
          if (body.action === "cancel") {
            quiescence.cancel(body.id);
            return quiescence.status();
          }
          try {
            return quiescence.prepare(body.id);
          } catch {
            return reply.code(409).send({ error: { code: "replacement_unavailable" } });
          }
        },
      );
    }
    for (const action of ["seal", "control"] as const) {
      server.post(
        `${PUBLICATION_PATH}/${action}`,
        { bodyLimit: MAX_EXECUTION_FACT_BYTES },
        async (request, reply) => {
          let value: unknown;
          try {
            if (!Buffer.isBuffer(request.body)) throw new Error("Binary JSON body required");
            // Preserve own __proto__/constructor data in opaque native Tool payloads.
            value = JSON.parse(request.body.toString("utf8"));
            const sessionId = (value as { scope?: { piSessionId?: unknown } })?.scope?.piSessionId;
            if (typeof sessionId !== "string" || sessionId.length < 1 || sessionId.length > 512)
              throw new Error("Invalid publication scope");
            const partition = this.projector.publicationPartition(sessionId);
            let owner: string | undefined;
            try {
              owner = await this.projector.ownerForPartition(partition);
            } catch {
              throw new PublicationIngressRejected("not_owner");
            }
            if (owner)
              return reply
                .code(307)
                .header("location", new URL(`${PUBLICATION_PATH}/${action}`, owner).toString())
                .send();
          } catch (error) {
            const reason = error instanceof PublicationIngressRejected ? error.reason : "scope";
            return reply.code(409).send({ error: { code: "publication_not_sent", reason } });
          }
          try {
            if (action === "control")
              return await this.projector.acceptControl(parseSessionControlChange(value));
            let fact;
            try {
              fact = parseAcceptedFact(value);
            } catch {
              throw new PublicationIngressRejected("scope");
            }
            if (fact.kind !== "execution_seal") throw new PublicationIngressRejected("scope");
            return await this.projector.acceptSeal(fact);
          } catch (error) {
            if (error instanceof PublicationNotSentError)
              return reply.code(409).send({
                error: {
                  code: "publication_not_sent",
                  reason:
                    error instanceof PublicationIngressRejected ? error.reason : "unavailable",
                },
              });
            return reply.code(503).send({ error: { code: "publication_unknown" } });
          }
        },
      );
    }
  }
}
