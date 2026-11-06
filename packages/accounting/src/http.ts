import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import { ModelMeteringService, MeteringConflict } from "./model-metering-service.ts";

export function installModelMeteringIngress(
  server: FastifyInstance,
  service: Pick<ModelMeteringService, "ingest">,
  token: string,
): void {
  if (!token.trim()) throw new TypeError("A metering receipt credential is required");
  const digest = createHash("sha256").update(`Bearer ${token}`).digest();
  server.post("/internal/v1/model-metering", { bodyLimit: 1_048_576 }, async (req, reply) => {
    const supplied = createHash("sha256")
      .update(req.headers.authorization ?? "")
      .digest();
    if (!timingSafeEqual(digest, supplied))
      return reply.code(401).send({ error: "authentication_required" });
    try {
      return await service.ingest(req.body);
    } catch (error) {
      if (error instanceof TypeError)
        return reply.code(400).send({ error: "invalid_model_receipt" });
      if (error instanceof MeteringConflict)
        return reply.code(409).send({ error: "model_receipt_conflict" });
      // Never acknowledge an unavailable database or log raw receipt payloads.
      return reply.code(503).send({ error: "model_metering_unavailable" });
    }
  });
}

export function createMeteringApplication(database: Kysely<Database>, token: string) {
  const server = Fastify({ logger: false, requestTimeout: 30_000 });
  installModelMeteringIngress(server, new ModelMeteringService(database), token);
  server.get("/health/live", () => ({ status: "alive" }));
  server.get("/health/ready", async (_req, reply) => {
    try {
      // A migrated table and a live PG connection are required, not the Control Plane.
      await sql`select id from model_invocations limit 0`.execute(database);
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });
  return server;
}
