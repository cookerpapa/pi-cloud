import type { FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { EXECUTOR_TARGET_BIND_PATH, parseExecutionTargetGrants } from "@pi-cloud/protocol";
import { ExecutionTargetService } from "./execution-target-service.ts";

export class ExecutionTargetIngress {
  constructor(
    readonly service: ExecutionTargetService,
    readonly token: string,
  ) {}
  install(server: FastifyInstance) {
    server.post(EXECUTOR_TARGET_BIND_PATH, { bodyLimit: 16384 }, async (request, reply) => {
      const expected = Buffer.from("Bearer " + this.token),
        actual = Buffer.from(request.headers.authorization ?? "");
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual))
        return reply.code(401).send();
      const body = request.body as { executionReference?: unknown; target?: unknown };
      if (!body || typeof body.executionReference !== "string")
        return reply.code(400).send({ error: "Invalid binding request" });
      try {
        const target = parseExecutionTargetGrants([body.target])[0]!;
        const bindingId = await this.service.prepare(body.executionReference, target);
        return { bindingId };
      } catch {
        return reply.code(409).send({ error: "Execution target binding is unavailable" });
      }
    });
  }
}
