import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { RESOURCE_BACKENDS_INTERNAL_PATH } from "@pi-cloud/protocol";
import type { ResourceBackendRegistry } from "./resource-backend-registry.ts";

export function installResourceBackendRoutes(
  server: FastifyInstance,
  registry: ResourceBackendRegistry,
  token: string,
  refresh: () => Promise<void>,
  registerDevice?: (tenantId: string, input: unknown) => Promise<unknown>,
) {
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  server.put(RESOURCE_BACKENDS_INTERNAL_PATH, { bodyLimit: 256 * 1024 }, async (request, reply) => {
    const supplied = createHash("sha256")
      .update(request.headers.authorization ?? "")
      .digest();
    if (!token || !timingSafeEqual(expected, supplied))
      return reply.code(401).send({ message: "Authentication required" });
    try {
      const resource = await registry.put(request.body);
      // Commit is the acknowledgment boundary. Client preparation also converges
      // through notifications/reconciliation if this listener disappears now.
      void refresh().catch(() => undefined);
      return resource;
    } catch (error) {
      const message =
        error instanceof Error &&
        /^(Backend revision changed|Backend connection changes require|New backend requires|Backend template uses|Invalid resource backend|Duplicate backend template)/.test(
          error.message,
        )
          ? error.message
          : "Backend registration could not verify its endpoint, credentials, template or storage; current registration was retained";
      return reply.code(error instanceof TypeError ? 400 : 409).send({ message });
    }
  });
  if (registerDevice)
    server.post(
      RESOURCE_BACKENDS_INTERNAL_PATH + "/devices",
      { bodyLimit: 8192 },
      async (request, reply) => {
        const supplied = createHash("sha256")
          .update(request.headers.authorization ?? "")
          .digest();
        if (!token || !timingSafeEqual(expected, supplied))
          return reply.code(401).send({ message: "Authentication required" });
        const body = request.body as { tenantId: string; device: unknown };
        try {
          return await registerDevice(body.tenantId, body.device);
        } catch {
          return reply.code(409).send({
            message:
              "Device registration could not verify its identity, capabilities or current ownership",
          });
        }
      },
    );
}
