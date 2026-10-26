import Fastify from "fastify";
import { timingSafeEqual } from "node:crypto";
import {
  ANDROID_CAPABILITIES,
  EXECUTOR_OPERATIONS_PATH,
  EXECUTOR_BINDING_PATH,
  parseExecutorOperation,
  parseExecutorCancellation,
  parseExecutorBinding,
} from "@pi-cloud/protocol";
import { AndroidExecutionManager, ExecutorRefusal } from "./execution-manager.ts";

export function createExecutorServer(options: {
  token: string;
  manager: AndroidExecutionManager;
  ready(): boolean;
  screenshot(signal: AbortSignal): Promise<string>;
}) {
  const server = Fastify({ logger: false, bodyLimit: 65536, requestTimeout: 10000 });
  server.addHook("onRequest", async (request, reply) => {
    if (request.url === "/health/live") return;
    const expected = Buffer.from("Bearer " + options.token),
      actual = Buffer.from(request.headers.authorization ?? "");
    if (!options.token || expected.length !== actual.length || !timingSafeEqual(expected, actual))
      return reply.code(401).send();
  });
  server.get("/health/live", async () => ({ alive: true }));
  server.get("/health/ready", async (_request, reply) => {
    const ready = options.ready();
    return reply.code(ready ? 200 : 503).send({
      targetId: options.manager.options.targetId,
      bootId: options.manager.options.bootId,
      ready,
      capabilities: ANDROID_CAPABILITIES,
    });
  });
  server.post(EXECUTOR_OPERATIONS_PATH, async (request) =>
    options.manager.submit(parseExecutorOperation(request.body)),
  );
  server.post(EXECUTOR_OPERATIONS_PATH + "/cancel", async (request) => {
    options.manager.cancel(parseExecutorCancellation(request.body));
    return { accepted: true };
  });
  server.post(EXECUTOR_BINDING_PATH + "/close", async (request) => {
    options.manager.closeBinding(parseExecutorBinding(request.body));
    return { accepted: true };
  });
  server.get("/screen", async (_request, reply) => {
    const abort = new AbortController();
    const close = () => abort.abort();
    reply.raw.once("close", close);
    try {
      return reply
        .type("image/png")
        .header("cache-control", "no-store")
        .send(
          Buffer.from(
            await options.screenshot(AbortSignal.any([abort.signal, AbortSignal.timeout(30000)])),
            "base64",
          ),
        );
    } finally {
      reply.raw.off("close", close);
    }
  });
  server.setErrorHandler((error, _request, reply) => {
    if (error instanceof ExecutorRefusal)
      return reply.code(409).send({ error: { code: error.code, effect: error.effect } });
    // Validation errors occur before submit. All other failures are conservative.
    if (error instanceof Error && /^Invalid executor /.test(error.message))
      return reply
        .code(400)
        .send({ error: { code: "executor_invalid_command", effect: "not_started" } });
    return reply.code(503).send({ error: { code: "executor_unavailable", effect: "unknown" } });
  });
  return server;
}
