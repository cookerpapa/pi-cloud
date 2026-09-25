import { createHash, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import {
  TOOL_PROGRESS_PATH,
  parseToolProgressDelivery,
  type ToolProgressDelivery,
} from "@pi-cloud/protocol";

export class ToolProgressIngress {
  constructor(
    readonly token: string,
    readonly owner: (partition: number) => Promise<string | undefined>,
    readonly publish: (delivery: ToolProgressDelivery) => void,
  ) {}
  install(server: FastifyInstance): void {
    const digest = (value: string) => createHash("sha256").update(value).digest();
    const credential = digest(`Bearer ${this.token}`);
    server.post(TOOL_PROGRESS_PATH, { bodyLimit: 65536 }, async (request, reply) => {
      if (!timingSafeEqual(credential, digest(request.headers.authorization ?? "")))
        return reply.code(401).send();
      let delivery: ToolProgressDelivery;
      try {
        delivery = parseToolProgressDelivery(request.body);
      } catch {
        return reply.code(400).send();
      }
      try {
        const owner = await this.owner(delivery.partition);
        if (owner)
          return reply
            .code(307)
            .header("location", new URL(TOOL_PROGRESS_PATH, owner).toString())
            .send();
        this.publish(delivery);
        return reply.code(204).send();
      } catch {
        // Assignment changes may lose observations; clients send only their next snapshot.
        return reply.code(503).send();
      }
    });
  }
}
