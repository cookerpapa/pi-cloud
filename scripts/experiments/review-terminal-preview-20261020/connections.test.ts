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
import { ProductionHttpGateway } from "../../../packages/control-plane/src/production-http-gateway.ts";
import { WorkspaceTerminalGateway } from "../../../packages/control-plane/src/workspace-terminal-gateway.ts";
import { previewConnectionAgent } from "../../../packages/control-plane/src/preview-connect.ts";
import {
  SandboxControlServer,
  type SandboxControlBackend,
} from "../../../packages/sandbox-control/src/sandbox-control-server.ts";

// Baseline characterizations, not fixed acceptance. All endpoints and streams
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
function record(value: object) {
  process.stdout.write(JSON.stringify(value) + "\n");
}
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

it("characterizes a valid terminal redirect losing to the old owner's close while PG validation waits", async () => {
  const oldOwner = await wsOwner();
  const nextOwner = await wsOwner();
  let newConnections = 0;
  nextOwner.on("connection", () => newConnections++);
  const validationEntered = Promise.withResolvers<void>();
  const releaseValidation = Promise.withResolvers<void>();
  oldOwner.on("connection", (socket) => {
    socket.once("message", () => {
      socket.send(
        JSON.stringify({
          workspaceTerminalProtocolVersion: 1,
          type: "workspace_terminal.owner_redirect",
          ownerBaseUrl: address(nextOwner),
        }),
        () => socket.close(1000, "following owner redirect"),
      );
    });
  });
  const browser = await terminalGateway(address(oldOwner), async () => {
    validationEntered.resolve();
    await releaseValidation.promise;
    return { owner_base_url: new URL(address(nextOwner)).toString() };
  });
  const closed = once(browser, "close");
  await validationEntered.promise;
  try {
    await closed;
    expect(browser.readyState).toBe(WebSocket.CLOSED);
    releaseValidation.resolve();
    await delay(30);
    expect(newConnections).toBe(0);
    record({
      case: "terminal_redirect_close_race",
      authorizedNextOwner: true,
      browserClosedDuringValidation: true,
      newConnections,
      databasePort: "controlled",
    });
  } finally {
    releaseValidation.resolve();
  }
});

it("characterizes an upstream terminal WebSocket handshake staying pending beyond 15 seconds", async () => {
  const owner = await httpOwner();
  const entered = Promise.withResolvers<void>();
  owner.on("upgrade", () => entered.resolve());
  const browser = await terminalGateway(address(owner));
  let frames = 0;
  browser.on("message", () => frames++);
  await entered.promise;
  const started = performance.now();
  await delay(16_000);
  expect(browser.readyState).toBe(WebSocket.OPEN);
  expect(frames).toBe(0);
  record({
    case: "terminal_handshake_without_deadline",
    observedWaitMs: Math.round(performance.now() - started),
    browserOpen: true,
    frames,
    note: "Finite observation plus source inspection; user disconnect still cancels it",
  });
}, 25_000);

it("characterizes request/agent destruction not cancelling its pending preview CONNECT", async () => {
  const owner = await httpOwner();
  const entered = Promise.withResolvers<Socket>();
  owner.on("connect", (_request, socket) => {
    socket.on("error", () => {});
    entered.resolve(socket as Socket);
  });
  const agent = previewConnectionAgent(address(owner), token, scope, true);
  cleanups.push(() => agent.destroy());
  const request = httpGet("http://localhost:4173/", { agent });
  request.on("error", () => {});
  const socket = await entered.promise;
  request.destroy();
  agent.destroy(); // Same teardown used by SandboxPreviewGateway.
  await delay(50);
  expect(socket.destroyed).toBe(false);
  record({
    case: "preview_pending_connect_not_cancelled",
    originalRequestDestroyed: request.destroyed,
    ownerSocketStillOpen: !socket.destroyed,
    sourceConnectDeadlineMs: 15_000,
  });
  // Completing the owned CONNECT lets Node discard the late socket. Never wait
  // for the production deadline or leave the deliberately blocked peer open.
  socket.end("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
  await vi.waitFor(() => expect(socket.destroyed).toBe(true));
});

it("characterizes Sandbox control accepting a late preview while close is draining", async () => {
  const entered = Promise.withResolvers<void>();
  const complete = Promise.withResolvers<PassThrough>();
  const stream = new PassThrough();
  const backend = {
    checkHealth: async () => {},
    close: async () => {},
    openPreviewConnection: async () => {
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
    await delay(50);
    complete.resolve(stream);
    late = await accepted.promise;
    late.socket.on("error", () => {});
    expect(late.status).toBe(200);
    expect(stream.destroyed).toBe(false);
    await delay(50);
    expect(closed).toBe(false);
    record({
      case: "preview_late_accept_while_server_closes",
      serverCloseStillWaiting: !closed,
      lateStatus: late.status,
      streamStillOpen: !stream.destroyed,
    });
  } finally {
    complete.resolve(stream);
    late?.socket.destroy();
    request.destroy();
    stream.destroy();
    await closing;
  }
});
