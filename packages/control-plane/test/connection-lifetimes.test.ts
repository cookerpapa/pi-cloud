import { afterEach, expect, it, vi } from "vitest";
import { once } from "node:events";
import { createServer, request as httpRequest, get as httpGet } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import WebSocket, { WebSocketServer } from "ws";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { PREVIEW_SCOPE_HEADER, SANDBOX_CONTROL_SANDBOX_PREVIEW_PATH } from "@pi-cloud/protocol";
import { ProductionHttpGateway } from "../src/production-http-gateway.ts";
import { WorkspaceTerminalGateway } from "../src/workspace-terminal-gateway.ts";
import { previewConnectionAgent } from "../src/preview-connect.ts";
import {
  SandboxControlServer,
  type SandboxControlBackend,
} from "../../sandbox-control/src/sandbox-control-server.ts";

// Owned connection-lifetime regressions. All endpoints and streams
// belong to this process. The DB port supplies explicit test authority only;
// no production database, VM, credentials or external network is used.
const token = "terminal-review-" + "a".repeat(48);
const ids = {
  tenant: "10000000-0000-4000-8000-000000000001",
  user: "10000000-0000-4000-8000-000000000002",
  workspace: "10000000-0000-4000-8000-000000000003",
  environment: "10000000-0000-4000-8000-000000000004",
};
const scope = {
  tenantId: ids.tenant,
  userId: ids.user,
  workspaceId: ids.workspace,
  target: { kind: "development_environment" as const, environmentId: ids.environment },
  port: 4173,
  expiresAt: Date.now() + 600_000,
};
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const address = (server: { address(): AddressInfo | string | null }) =>
  `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
async function httpOwner() {
  const server = createServer();
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return server;
}
async function wsOwner() {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  cleanups.push(async () => {
    for (const socket of server.clients) socket.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return server;
}
async function terminalGateway(
  owner: string,
  validateOwner: () => Promise<{ owner_base_url: string }> = async () => ({
    owner_base_url: owner,
  }),
) {
  const database = {
    selectFrom(table: string) {
      const builder = {
        innerJoin: () => builder,
        select: () => builder,
        where: () => builder,
        executeTakeFirst: async () =>
          table === "sandbox_control_instances"
            ? validateOwner()
            : {
                id: ids.environment,
                state: "running",
                domainId: "owned-review-domain",
                sandboxControlBaseUrl: owner,
              },
      };
      return builder;
    },
  } as unknown as Kysely<Database>;
  const app = Fastify({ logger: false });
  app.register(fastifyWebsocket);
  new ProductionHttpGateway({
    authenticator: {
      authenticate: async (candidate) =>
        candidate === token
          ? {
              credentialId: ids.user,
              tenantId: ids.tenant,
              tenantSlug: "owned-review",
              userId: ids.user,
              displayName: "Owned review",
              role: "member" as const,
              defaultModelProfileId: ids.workspace,
            }
          : undefined,
    },
    readiness: () => true,
  }).install(app);
  new WorkspaceTerminalGateway({
    database,
    terminalToken: token,
    allowInsecureInternalHttp: true,
  }).install(app);
  const base = await app.listen({ host: "127.0.0.1", port: 0 });
  cleanups.push(() => app.close());
  const browser = new WebSocket(
    base.replace("http:", "ws:") + `/v1/development-environments/${ids.environment}/terminal`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  browser.on("error", () => {});
  cleanups.push(async () => {
    if (browser.readyState === WebSocket.CLOSED) return;
    const ended = once(browser, "close");
    browser.terminate();
    await ended;
  });
  return browser;
}

it.each(["valid", "invalid", "cancelled"])(
  "handles terminal redirect/old-peer close while validation waits (%s)",
  async (mode) => {
    const oldOwner = await wsOwner(),
      nextOwner = await wsOwner();
    let newConnections = 0;
    nextOwner.on("connection", () => newConnections++);
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    oldOwner.on("connection", (socket) =>
      socket.once("message", () =>
        socket.send(
          JSON.stringify({
            workspaceTerminalProtocolVersion: 1,
            type: "workspace_terminal.owner_redirect",
            ownerBaseUrl: address(nextOwner),
          }),
          () => socket.close(1000, "following owner redirect"),
        ),
      ),
    );
    const browser = await terminalGateway(address(oldOwner), async () => {
      entered.resolve();
      await release.promise;
      if (mode === "invalid") throw new Error("Owner changed during validation");
      return { owner_base_url: new URL(address(nextOwner)).toString() };
    });
    await entered.promise;
    try {
      await delay(30);
      expect(browser.readyState).toBe(WebSocket.OPEN);
      if (mode === "cancelled") {
        const closed = once(browser, "close");
        browser.terminate();
        await closed;
      }
      release.resolve();
      if (mode === "valid") {
        await vi.waitFor(() => expect(newConnections).toBe(1));
        expect(browser.readyState).toBe(WebSocket.OPEN);
      } else {
        await vi.waitFor(() => expect(browser.readyState).toBe(WebSocket.CLOSED));
        expect(newConnections).toBe(0);
      }
    } finally {
      release.resolve();
    }
  },
);

it("bounds terminal connection establishment and returns a retryable error", async () => {
  const owner = await httpOwner();
  const entered = Promise.withResolvers<void>();
  owner.on("upgrade", () => entered.resolve());
  const browser = await terminalGateway(address(owner));
  const frames: unknown[] = [];
  browser.on("message", (raw) => frames.push(JSON.parse(raw.toString())));
  const closed = once(browser, "close");
  await entered.promise;
  await closed;
  expect(frames).toContainEqual(
    expect.objectContaining({ type: "workspace_terminal.error", retryable: true }),
  );
  expect(browser.readyState).toBe(WebSocket.CLOSED);
}, 20000);

it("cancels an owned pending CONNECT when the outer request and agent are destroyed", async () => {
  const owner = await httpOwner();
  const entered = Promise.withResolvers<Socket>();
  owner.on("connect", (_request, socket) => {
    socket.on("error", () => {});
    socket.once("end", () => socket.end());
    socket.resume();
    entered.resolve(socket as Socket);
  });
  const agent = previewConnectionAgent(address(owner), token, scope, true);
  cleanups.push(() => agent.destroy());
  const request = httpGet("http://localhost:4173/", { agent });
  request.on("error", () => {});
  const socket = await entered.promise;
  request.destroy();
  agent.destroy(); // Same teardown used by SandboxPreviewGateway.
  await vi.waitFor(() => expect(socket.destroyed).toBe(true));
});

it("joins pending preview opens and disposes late streams during server shutdown", async () => {
  const entered = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<PassThrough>();
  const stream = new PassThrough();
  let openSignal: AbortSignal | undefined;
  const backend = {
    checkHealth: async () => {},
    close: async () => {},
    openPreviewConnection: async (_scope: unknown, signal: AbortSignal) => {
      openSignal = signal;
      entered.resolve();
      return complete.promise;
    },
    providerId: "owned-review",
    activeCount: 0,
    admittedCount: 0,
    admissionWaitingCount: 0,
    maximumActiveSandboxes: 10,
    cleanPrewarmCount: 0,
  } as unknown as SandboxControlBackend;
  const server = new SandboxControlServer({
    host: "127.0.0.1",
    port: 0,
    serviceToken: token,
    terminalToken: token,
    broker: backend,
  });
  const base = await server.listen();
  cleanups.push(() => server.close());
  const request = httpRequest(new URL(SANDBOX_CONTROL_SANDBOX_PREVIEW_PATH, base), {
    method: "CONNECT",
    headers: {
      authorization: `Bearer ${token}`,
      [PREVIEW_SCOPE_HEADER]: Buffer.from(JSON.stringify(scope)).toString("base64url"),
    },
  });
  const accepted = Promise.withResolvers<{ status: number; socket: Socket }>();
  request.on("error", accepted.reject);
  void accepted.promise.catch(() => {});
  request.once("connect", (response, socket) =>
    accepted.resolve({ status: response.statusCode!, socket }),
  );
  request.end();
  cleanups.push(() => {
    request.destroy();
    stream.destroy();
  });
  await entered.promise;
  let closed = false;
  const closing = server.close().then(() => {
    closed = true;
  });
  let late: { status: number; socket: Socket } | undefined;
  try {
    await vi.waitFor(() => expect(openSignal?.aborted).toBe(true));
    expect(closed).toBe(false); // joining the controlled late open
    complete.resolve(stream);
    late = await accepted.promise.catch(() => undefined);
    await closing;
    expect(late?.status).not.toBe(200);
    expect(stream.destroyed).toBe(true);
    expect(closed).toBe(true);
  } finally {
    complete.resolve(stream);
    late?.socket.destroy();
    request.destroy();
    stream.destroy();
    await closing;
  }
});
