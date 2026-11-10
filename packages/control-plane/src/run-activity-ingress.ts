import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  RUN_ACTIVITY_PATH,
  parseRunActivityDelivery,
  type RunActivityDelivery,
  EXECUTION_OBSERVATION_PATH,
  EXECUTION_READINESS_PATH,
  parseExecutionObservationDelivery,
  type ExecutionObservationDelivery,
} from "@pi-cloud/protocol";

/** Uses the existing trusted Worker management credential, never Broker credentials. */
export class RunActivityIngress {
  constructor(
    readonly token: string,
    readonly owner: (partition: number) => Promise<string | undefined>,
    readonly publish: (delivery: RunActivityDelivery) => void,
    readonly execution?: (delivery: ExecutionObservationDelivery) => void,
    readonly readiness?: (delivery: ExecutionObservationDelivery) => Promise<boolean>,
  ) {}
  install(server: FastifyInstance): void {
    const digest = (value: string) => createHash("sha256").update(value).digest();
    const credential = digest(`Bearer ${this.token}`);
    for (const path of [EXECUTION_OBSERVATION_PATH, EXECUTION_READINESS_PATH])
      server.post(path, { bodyLimit: 4096 }, async (request, reply) => {
        if (!timingSafeEqual(credential, digest(request.headers.authorization ?? "")))
          return reply.code(401).send();
        let value: ExecutionObservationDelivery;
        try {
          value = parseExecutionObservationDelivery(request.body);
        } catch {
          return reply.code(400).send();
        }
        try {
          const owner = await this.owner(value.partition);
          if (owner)
            return reply.code(307).header("location", new URL(path, owner).toString()).send();
          if (path === EXECUTION_READINESS_PATH)
            return reply
              .code(value.kind === "probe" && (await this.readiness?.(value)) ? 204 : 409)
              .send();
          this.execution?.(value);
          return reply.code(204).send();
        } catch {
          return reply.code(503).send();
        }
      });
    server.post(RUN_ACTIVITY_PATH, { bodyLimit: 4096 }, async (request, reply) => {
      if (!timingSafeEqual(credential, digest(request.headers.authorization ?? "")))
        return reply.code(401).send();
      let delivery: RunActivityDelivery;
      try {
        delivery = parseRunActivityDelivery(request.body);
      } catch {
        return reply.code(400).send();
      }
      try {
        const owner = await this.owner(delivery.partition);
        if (owner)
          return reply
            .code(307)
            .header("location", new URL(RUN_ACTIVITY_PATH, owner).toString())
            .send();
        this.publish(delivery);
        return reply.code(204).send();
      } catch {
        return reply.code(503).send();
      }
    });
  }
}
