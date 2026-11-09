import { createHash, timingSafeEqual } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import { sql, type Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import { ModelMeteringService } from "./model-metering-service.ts";
import { ResourceMeteringService } from "./resource-metering-service.ts";
import { MeteringConflict } from "./receipt-identity.ts";
import { parseResourceMeteringBatch } from "@pi-cloud/protocol";

export function installMeteringIngress(
  server: FastifyInstance,
  service: { ingest(value: unknown): Promise<{ accepted: number }> },
  token: string,
  kind: "model" | "resource",
): void {
  if (!token.trim()) throw new TypeError("A metering receipt credential is required");
  const digest = createHash("sha256").update(`Bearer ${token}`).digest();
  server.post(`/internal/v1/${kind}-metering`, { bodyLimit: 1_048_576 }, async (req, reply) => {
    const supplied = createHash("sha256")
      .update(req.headers.authorization ?? "")
      .digest();
    if (!timingSafeEqual(digest, supplied))
      return reply.code(401).send({ error: "authentication_required" });
    try {
      if (
        kind === "resource" &&
        parseResourceMeteringBatch(req.body).events.some(
          (event) => event.resource.kind !== "workspace",
        )
      )
        return reply.code(409).send({ error: "compute_usage_requires_lifecycle_source" });
      return await service.ingest(req.body);
    } catch (error) {
      if (error instanceof TypeError)
        return reply.code(400).send({ error: `invalid_${kind}_receipt` });
      if (error instanceof MeteringConflict)
        return reply.code(409).send({ error: `${kind}_receipt_conflict` });
      // Never acknowledge an unavailable database or log raw receipt payloads.
      return reply.code(503).send({ error: `${kind}_metering_unavailable` });
    }
  });
}

export function createMeteringApplication(database: Kysely<Database>, token: string) {
  const server = Fastify({ logger: false, requestTimeout: 30_000 });
  installMeteringIngress(server, new ModelMeteringService(database), token, "model");
  installMeteringIngress(server, new ResourceMeteringService(database), token, "resource");
  server.get("/health/live", () => ({ status: "alive" }));
  server.get("/health/ready", async (_req, reply) => {
    try {
      // A migrated table and a live PG connection are required, not the Control Plane.
      await sql`select (select id from model_invocations limit 1), (select id from resource_metering_events limit 1)`.execute(
        database,
      );
      return { status: "ready" };
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });
  return server;
}
