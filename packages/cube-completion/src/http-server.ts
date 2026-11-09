import { ToolCompletionCapabilities } from "@pi-cloud/protocol/completion-capability";
import Fastify from "fastify";
import { MAX_IMAGE_GUEST_RESPONSE_BYTES, type ToolCompletionGrant } from "@pi-cloud/protocol";
import type { CubeCompletionAdapter, CompletionPacket } from "./adapter.ts";

/** Only delivery lives here. It cannot start Tools, renew leases or close VMs. */
export function completionServer(options: {
  key: string;
  cert: string;
  authority: ToolCompletionCapabilities;
  adapter: Pick<CubeCompletionAdapter, "accept">;
  ready(): Promise<void>;
}) {
  const server = Fastify({
    logger: false,
    https: { key: options.key, cert: options.cert },
    bodyLimit: MAX_IMAGE_GUEST_RESPONSE_BYTES + 16384,
    requestTimeout: 120_000,
  });
  const grants = new WeakMap<object, ToolCompletionGrant>();
  const reservations = new Map<object, number>();
  const processing = new WeakSet<object>();
  let bytes = 0;
  const release = (request: object) => {
    const size = reservations.get(request);
    if (size !== undefined) {
      bytes -= size;
      reservations.delete(request);
    }
  };
  server.addHook("onRequest", async (request, reply) => {
    if (request.url !== "/v1/completions") return;
    try {
      const auth = request.headers.authorization;
      if (!auth?.startsWith("Bearer ")) throw new Error("Missing capability");
      grants.set(request, options.authority.read(auth.slice(7)));
    } catch {
      return reply.code(401).send();
    }
    const size = Number(request.headers["content-length"]);
    if (!Number.isSafeInteger(size) || size < 2) return reply.code(411).send();
    if (size > MAX_IMAGE_GUEST_RESPONSE_BYTES + 16384) return reply.code(413).send();
    if (reservations.size >= 32 || bytes + size > 256 * 1024 * 1024) return reply.code(503).send();
    reservations.set(request, size);
    bytes += size;
    reply.raw.once("close", () => {
      if (!processing.has(request)) release(request);
    });
  });
  server.addHook("onResponse", async (request) => {
    if (!processing.has(request)) release(request);
  });
  server.post("/v1/completions", async (request, reply) => {
    const grant = grants.get(request)!;
    const body = request.body as {
      kind?: string;
      operationId?: string;
      output?: unknown;
      result?: CompletionPacket["result"];
    };
    if (
      !body ||
      body.operationId !== grant.operationId ||
      !["progress", "result"].includes(body.kind ?? "") ||
      Object.keys(body).some((key) => !["kind", "operationId", "output", "result"].includes(key)) ||
      (grant.issuer === "guest" && body.result !== undefined) ||
      (grant.issuer === "executor" && body.kind === "result" && !body.result)
    )
      return reply.code(409).send();
    const packet: CompletionPacket = {
      operationId: grant.operationId,
      context: grant.context,
      kind: body.kind as CompletionPacket["kind"],
      ...(body.kind === "progress"
        ? { output: body.output }
        : { result: grant.issuer === "guest" ? { output: body.output } : body.result! }),
    };
    processing.add(request);
    try {
      await options.adapter.accept(packet);
      return reply.code(204).send(); // final ACK follows Kafka publication
    } catch {
      return reply.code(503).send();
    } finally {
      processing.delete(request);
      release(request);
    }
  });
  server.get("/health/live", async () => ({ status: "ok" }));
  server.get("/health/ready", async (_request, reply) => {
    try {
      await options.ready();
      return reply.send({ status: "ready" });
    } catch {
      return reply.code(503).send({ status: "unavailable" });
    }
  });
  return server;
}
