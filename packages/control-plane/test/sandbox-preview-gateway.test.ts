import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import { createServer, request as httpRequest } from "node:http";
import { connect } from "node:net";
import WebSocket, { WebSocketServer } from "ws";
import {
  SandboxPreviewGateway,
  issuePreviewAccessToken,
  verifyPreviewAccessToken,
  previewOriginHostname,
  previewCookie,
  PREVIEW_COOKIE,
  PREVIEW_BOOTSTRAP_PATH,
} from "../src/sandbox-preview-gateway.ts";
import { PREVIEW_SCOPE_HEADER } from "@pi-cloud/protocol";

const secret = "preview-secret-" + "x".repeat(40);
const scope = {
  tenantId: "10000000-0000-4000-8000-000000000001",
  userId: "10000000-0000-4000-8000-000000000002",
  workspaceId: "10000000-0000-4000-8000-000000000003",
  target: {
    kind: "development_environment" as const,
    environmentId: "10000000-0000-4000-8000-000000000004",
  },
  port: 4173,
};
const hostname = previewOriginHostname(
  secret,
  "preview.test",
  scope.target,
  scope.port,
  scope.workspaceId,
);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture() {
  const observed: Array<{
    path: string;
    cookie: string | undefined;
    authorization: string | undefined;
  }> = [];
  let releaseStream: () => void = () => {};
  const app = createServer((req, res) => {
    observed.push({
      path: req.url!,
      cookie: req.headers.cookie,
      authorization: req.headers.authorization,
    });
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: first\n\n");
      releaseStream = () => res.end("data: last\n\n");
      return;
    }
    if (req.url === "/binary") {
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(Buffer.from([0, 255, 1, 13, 10]));
      return;
    }
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "/api/value" });
      res.end();
      return;
    }
    res.writeHead(200, {
      "content-type": req.url === "/src/main.js" ? "text/javascript" : "text/plain",
      "set-cookie": [
        "app_session=ok; Domain=localhost; Path=/",
        `${PREVIEW_COOKIE}=forged; Path=/`,
      ],
    });
    res.end("application " + req.url);
  });
  const sockets = new Set<import("node:net").Socket>();
  app.on("connection", (s) => {
    sockets.add(s);
    s.once("close", () => sockets.delete(s));
  });
  const wss = new WebSocketServer({ server: app });
  wss.on("connection", (ws) => ws.on("message", (data, binary) => ws.send(data, { binary })));
  await new Promise<void>((r) => app.listen(0, "127.0.0.1", r));
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    wss.close();
    await new Promise<void>((r) => app.close(() => r()));
  });
  const connections: Array<unknown> = [];
  const broker = createServer();
  broker.on("connect", (req, socket, head) => {
    connections.push(
      JSON.parse(Buffer.from(req.headers[PREVIEW_SCOPE_HEADER] as string, "base64url").toString()),
    );
    expect(req.headers.authorization).toBe(`Bearer ${secret}`);
    const upstream = connect(
      (app.address() as import("node:net").AddressInfo).port,
      "127.0.0.1",
      () => {
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        socket.pipe(upstream);
        upstream.pipe(socket);
      },
    );
    socket.on("error", () => upstream.destroy());
    upstream.on("error", () => socket.destroy());
    socket.once("close", () => upstream.destroy());
  });
  await new Promise<void>((r) => broker.listen(0, "127.0.0.1", r));
  cleanups.push(() => new Promise<void>((r) => broker.close(() => r())));
  let available = true;
  const database = {
    selectFrom() {
      const filters: Array<[string, string, unknown]> = [];
      const builder = {
        innerJoin() {
          return builder;
        },
        leftJoin() {
          return builder;
        },
        select() {
          return builder;
        },
        where(...args: [string, string, unknown]) {
          filters.push(args);
          return builder;
        },
        orderBy() {
          return builder;
        },
        async executeTakeFirst() {
          if (
            !available ||
            filters.some(
              ([key, , value]) => key.endsWith("owner_user_id") && value !== scope.userId,
            )
          )
            return undefined;
          return {
            workspace_id: scope.workspaceId,
            ownerBaseUrl: `http://127.0.0.1:${(broker.address() as import("node:net").AddressInfo).port}`,
          };
        },
      };
      return builder;
    },
  };
  const gateway = new SandboxPreviewGateway({
    database: database as never,
    previewToken: secret,
    publicOriginBaseUrl: "http://preview.test:8080",
    allowInsecureInternalHttp: true,
  });
  const fastify = Fastify();
  gateway.install(fastify);
  await fastify.ready();
  cleanups.push(() => fastify.close());
  const ticket = issuePreviewAccessToken(secret, scope);
  const request = (path: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: Buffer }>(
      (resolve) => {
        httpRequest(
          new URL(path, gateway.address),
          {
            headers: {
              host: hostname + ":8080",
              cookie: `${PREVIEW_COOKIE}=${ticket}`,
              ...headers,
            },
          },
          (res) => {
            const bytes: Buffer[] = [];
            res.on("data", (b) => bytes.push(b));
            res.on("end", () =>
              resolve({
                status: res.statusCode!,
                headers: res.headers,
                body: Buffer.concat(bytes),
              }),
            );
          },
        ).end();
      },
    );
  return {
    gateway,
    ticket,
    request,
    observed,
    connections,
    releaseStream: () => releaseStream(),
    releaseResource: () => {
      available = false;
    },
  };
}

describe("root-origin Preview", () => {
  it("scopes authority to expiry/workspace and uses host-only HttpOnly cookies", () => {
    const token = issuePreviewAccessToken(secret, scope, 1000);
    expect(verifyPreviewAccessToken(secret, token, 1000)).toMatchObject(scope);
    expect(verifyPreviewAccessToken(secret, token, 901000)).toBeUndefined();
    expect(verifyPreviewAccessToken(secret, token.slice(0, -2) + "xx", 1000)).toBeUndefined();
    expect(previewCookie(token, 901000, true)).toContain("HttpOnly; SameSite=Lax");
    expect(previewCookie(token, 901000, true)).toContain("; Secure");
    expect(previewCookie(token, 901000, true)).not.toContain("Domain=");
    expect(
      previewOriginHostname(secret, "preview.test", scope.target, scope.port, "another-workspace"),
    ).not.toBe(hostname);
  });
  it("exchanges the ticket and proxies absolute paths including /v1 as app paths", async () => {
    const f = await fixture();
    const bootstrap = await f.request(
      `${PREVIEW_BOOTSTRAP_PATH}?ticket=${f.ticket}&path=${encodeURIComponent("/app?x=1")}`,
      { cookie: "" },
    );
    expect(bootstrap.status).toBe(303);
    expect(bootstrap.headers.location).toBe("/app?x=1");
    expect(bootstrap.headers["set-cookie"]?.[0]).toContain("HttpOnly");
    const js = await f.request("/src/main.js", {
      cookie: `${PREVIEW_COOKIE}=${f.ticket}; pi_cloud_session=platform-secret; app_session=abc`,
      authorization: "Bearer app-token",
    });
    expect(js.headers["content-type"]).toBe("text/javascript");
    expect(js.body.toString()).toBe("application /src/main.js");
    expect(f.observed[0]).toEqual({
      path: "/src/main.js",
      cookie: "app_session=abc",
      authorization: "Bearer app-token",
    });
    expect(js.headers["set-cookie"]).toEqual(["app_session=ok; Path=/"]);
    expect(js.headers["content-security-policy"]).toContain("style-src 'self' 'unsafe-inline'");
    expect((await f.request("/v1/auth/login")).body.toString()).toBe("application /v1/auth/login");
    expect((await f.request("/binary")).body).toEqual(Buffer.from([0, 255, 1, 13, 10]));
    expect((await f.request("/redirect")).headers.location).toBe(
      `http://${hostname}:8080/api/value`,
    );
    expect(f.connections[0]).toMatchObject(scope);
  });
  it("rejects missing/expired/wrong-origin/wrong-user authority and released resources", async () => {
    const f = await fixture();
    expect((await f.request("/", { cookie: "" })).status).toBe(401);
    expect((await f.request("/", { host: "main.test" })).status).toBe(401);
    expect((await f.request("/", { origin: "http://other.test" })).status).toBe(401);
    expect(
      (
        await f.request("/", {
          cookie: `${PREVIEW_COOKIE}=${issuePreviewAccessToken(secret, scope, 1)}`,
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await f.request("/", {
          cookie: `${PREVIEW_COOKIE}=${issuePreviewAccessToken(secret, { ...scope, userId: "10000000-0000-4000-8000-000000000099" })}`,
        })
      ).status,
    ).toBe(502);
    expect(f.connections).toHaveLength(0);
    f.releaseResource();
    expect((await f.request("/")).status).toBe(502);
  });
  it("streams SSE before completion and proxies WebSocket frames", async () => {
    const f = await fixture();
    await new Promise<void>((resolve, reject) => {
      httpRequest(
        new URL("/events", f.gateway.address),
        { headers: { host: hostname + ":8080", cookie: `${PREVIEW_COOKIE}=${f.ticket}` } },
        (res) => {
          const chunks: string[] = [];
          res.on("data", (chunk) => {
            chunks.push(chunk.toString());
            if (chunks.length === 1) {
              expect(chunk.toString()).toContain("data: first");
              f.releaseStream();
            }
          });
          res.on("end", () => {
            expect(chunks.join("")).toContain("data: last");
            resolve();
          });
          res.on("error", reject);
        },
      )
        .on("error", reject)
        .end();
    });
    const ws = new WebSocket(
      f.gateway.address!.replace("http:", "ws:") + "/socket?x=1",
      "vite-hmr",
      {
        headers: {
          host: hostname + ":8080",
          origin: `http://${hostname}:8080`,
          cookie: `${PREVIEW_COOKIE}=${f.ticket}`,
        },
      },
    );
    await new Promise<void>((resolve, reject) => {
      ws.once("open", resolve);
      ws.once("error", reject);
    });
    expect(ws.protocol).toBe("vite-hmr");
    const echoed = new Promise<Buffer>((r) =>
      ws.once("message", (data) => r(Buffer.from(data as Buffer))),
    );
    ws.send(Buffer.from([0, 255, 7]));
    expect(await echoed).toEqual(Buffer.from([0, 255, 7]));
    await new Promise<void>((r) => {
      ws.once("close", () => r());
      ws.close();
    });
  });
});
