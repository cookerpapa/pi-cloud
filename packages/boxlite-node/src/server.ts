import Fastify from "fastify";
import { WebSocketServer, createWebSocketStream } from "ws";
import { pipeline } from "node:stream";
import { BOXLITE_NODE_PATH } from "@pi-cloud/sandbox-control/boxlite-node-contract";
import type { BoxLiteInstance } from "@pi-cloud/sandbox-control/boxlite-node-contract";
import type {
  GuestCommandRequest,
  GuestRuntimeCreateInput,
} from "@pi-cloud/sandbox-control/guest-runtime";
import type { BoxLiteNodeBackend } from "./backend.ts";

const identity = (value: string) => {
  if (!/^[A-Za-z0-9_.-]{1,128}$/.test(value)) throw new Error("Invalid native resource identity");
  return value;
};

export function createBoxLiteNodeServer(backend: BoxLiteNodeBackend, token: string) {
  if (token.length < 32) throw new Error("BoxLite node credential is unavailable");
  const server = Fastify({ logger: false, bodyLimit: 64 * 1024 * 1024, requestTimeout: 0 });
  const prefix = BOXLITE_NODE_PATH;
  server.addHook("onRequest", async (request, reply) => {
    if (request.url.startsWith(prefix) && request.headers.authorization !== `Bearer ${token}`)
      return reply.code(401).send({ code: "unauthorized" });
  });
  server.setErrorHandler((_error, _request, reply) => {
    // SDK/control failures may contain local paths or upstream diagnostics.
    // Preserve uncertainty without echoing command bodies or credentials.
    return reply.code(503).send({ code: "boxlite_operation_unconfirmed" });
  });
  server.get("/health/live", async () => ({ status: "ok" }));
  server.get("/health/ready", async () => {
    await backend.ready();
    return { status: "ready", nodeId: backend.options.nodeId, sdkVersion: "0.12.0" };
  });
  server.get(prefix + "/boxes", async () => ({ instances: await backend.list() }));
  server.get(prefix + "/inventory", async () => backend.inventory());
  server.post<{ Body: GuestRuntimeCreateInput }>(prefix + "/boxes", async (request) =>
    backend.create(request.body),
  );
  server.get<{ Params: { id: string } }>(prefix + "/boxes/:id", async (request) => ({
    instance: (await backend.read(identity(request.params.id))) ?? null,
  }));
  server.post<{ Body: BoxLiteInstance }>(prefix + "/delete", async (request) => {
    identity(request.body.sandboxId);
    await backend.destroy(request.body);
    return { confirmed: true };
  });
  server.post<{ Body: { id: string; expected?: BoxLiteInstance } }>(
    prefix + "/observe",
    async (request) => backend.observe(identity(request.body.id), request.body.expected),
  );
  for (const action of ["pause", "resume"] as const)
    server.post<{ Params: { id: string } }>(prefix + `/boxes/:id/${action}`, async (request) => {
      const id = identity(request.params.id);
      if (action === "resume") return backend.resume(id);
      await backend.pause(id);
      return { confirmed: true };
    });
  server.post<{ Params: { id: string }; Body: Omit<GuestCommandRequest, "signal" | "onStdout"> }>(
    prefix + "/boxes/:id/command",
    async (request) => {
      const input = request.body;
      if (
        !input ||
        typeof input.command !== "string" ||
        !["root", "0:0", "user", "1000:1000"].includes(input.user) ||
        typeof input.cwd !== "string" ||
        !Number.isSafeInteger(input.timeoutMs) ||
        input.timeoutMs < 1 ||
        !Number.isSafeInteger(input.maximumOutputBytes) ||
        input.maximumOutputBytes < 1 ||
        input.maximumOutputBytes > 64 * 1024 * 1024
      )
        throw new Error("Invalid Guest control request");
      return backend.command(identity(request.params.id), input);
    },
  );
  server.post<{ Params: { id: string }; Body: object }>(
    prefix + "/boxes/:id/guest",
    async (request) => {
      if (!request.body || typeof request.body !== "object" || Array.isArray(request.body))
        throw new Error("Invalid Guest request");
      return backend.guest(identity(request.params.id), request.body);
    },
  );
  server.post<{
    Params: { id: string; execution: string };
    Body: { action: "resize" | "kill"; rows?: number; cols?: number };
  }>(prefix + "/boxes/:id/executions/:execution", async (request) => {
    if (!["resize", "kill"].includes(request.body.action))
      throw new Error("Unknown execution control");
    const size =
      request.body.rows === undefined || request.body.cols === undefined
        ? undefined
        : { rows: request.body.rows, cols: request.body.cols };
    await backend.executionControl(
      identity(request.params.id),
      identity(request.params.execution),
      request.body.action,
      size,
    );
    return { confirmed: true };
  });
  server.addContentTypeParser("application/octet-stream", (_request, stream, done) =>
    done(null, stream),
  );
  server.put<{
    Params: { id: string };
    Querystring: { path: string; bytes: string };
    Body: AsyncIterable<Uint8Array>;
  }>(prefix + "/boxes/:id/file", async (request) => {
    const controller = new AbortController();
    const lost = () => controller.abort(new Error("Upload connection ended"));
    request.raw.once("aborted", lost);
    try {
      await backend.writeFile(
        identity(request.params.id),
        request.query.path,
        request.body,
        Number(request.query.bytes),
        controller.signal,
      );
    } finally {
      request.raw.off("aborted", lost);
    }
    return { confirmed: true };
  });

  const sockets = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  server.server.on("upgrade", (request, socket, head) => {
    if (request.url !== prefix + "/stream" || request.headers.authorization !== `Bearer ${token}`) {
      socket.destroy();
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      const initial = setTimeout(() => ws.close(1008), 10000);
      initial.unref();
      ws.once("close", () => clearTimeout(initial));
      ws.once("message", (bytes) => {
        clearTimeout(initial);
        void (async () => {
          const request = JSON.parse(bytes.toString()) as {
            id: string;
            kind: "tcp" | "program";
            port?: number;
            script?: string;
            cwd?: string;
            tty?: boolean;
            admin?: boolean;
            rows?: number;
            cols?: number;
          };
          const id = identity(request.id);
          let stream: import("node:stream").Duplex, executionId: string | undefined;
          if (request.kind === "tcp") {
            if (!Number.isSafeInteger(request.port) || request.port! < 1 || request.port! > 65535)
              throw new Error("Invalid application port");
            stream = await backend.tcp(id, request.port!);
          } else if (
            request.kind === "program" &&
            typeof request.script === "string" &&
            request.script.length <= 65536 &&
            typeof request.cwd === "string"
          ) {
            const program = await backend.program(
              id,
              request.script,
              request.cwd,
              request.tty === true,
              request.admin === true && request.tty === true,
            );
            stream = program.stream;
            executionId = await program.execution.id();
            if (request.tty)
              await program.execution.resizeTty(request.rows ?? 24, request.cols ?? 80);
          } else throw new Error("Unknown native stream request");
          if (ws.readyState !== ws.OPEN) {
            stream.destroy();
            return;
          }
          ws.send(JSON.stringify({ ready: true, ...(executionId ? { executionId } : {}) }));
          const wire = createWebSocketStream(ws);
          pipeline(wire, stream, () => wire.destroy());
          pipeline(stream, wire, () => stream.destroy());
        })().catch(() => {
          if (ws.readyState === ws.OPEN) ws.close(1011);
        });
      });
    });
  });
  server.addHook("preClose", async () => {
    for (const ws of sockets.clients) ws.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
  });
  server.addHook("onClose", async () => {
    await backend.close();
  });
  return server;
}
