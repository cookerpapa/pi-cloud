import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  RUN_ACTIVITY_PATH,
  parseRunActivityDelivery,
  type RunActivityDelivery,
  EXECUTION_OBSERVATION_PATH,
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
  ) {}
  install(server: FastifyInstance): void {
    const digest = (value: string) => createHash("sha256").update(value).digest();
    const credential = digest(`Bearer ${this.token}`);
    server.post(EXECUTION_OBSERVATION_PATH, { bodyLimit: 4096 }, async (request, reply) => {
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
          return reply
            .code(307)
            .header("location", new URL(EXECUTION_OBSERVATION_PATH, owner).toString())
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
