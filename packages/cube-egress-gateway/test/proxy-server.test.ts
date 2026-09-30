import { createServer, request, type Server } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import type { CubeEgressRuntimeConfiguration } from "../src/configuration-poller.ts";
import { createCubeEgressGateway, type CubeEgressAuditRecord } from "../src/proxy-server.ts";

const servers: Server[] = [];

async function listen(server: Server): Promise<number> {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return (server.address() as AddressInfo).port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map(close));
});

async function upstream(label: string): Promise<number> {
  return listen(
    createServer((incoming, response) => {
      response.writeHead(200, {
        "content-type": "text/plain",
        "x-observed-target": incoming.url ?? "",
      });
      response.end(label);
    }),
  );
}

async function throughGateway(
  gatewayPort: number,
  target: string,
): Promise<{ status: number; body: string; target?: string }> {
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        host: "127.0.0.1",
        port: gatewayPort,
        method: "GET",
        path: target,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
            ...(response.headers["x-observed-target"] === undefined
              ? {}
              : { target: String(response.headers["x-observed-target"]) }),
          }),
        );
      },
    );
    outgoing.once("error", reject);
    outgoing.end();
  });
}

async function throughConnect(gatewayPort: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(gatewayPort, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.once("connect", () => {
      socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
    });
    socket.on("data", (chunk: Buffer) => chunks.push(chunk));
    socket.once("error", reject);
    socket.once("close", () => resolve(Buffer.concat(chunks).toString("latin1")));
  });
}

describe("Cube egress gateway", () => {
  it.each(["content-length", "chunked"])(
    "terminates a truncated upstream %s response without hanging the client",
    async (framing) => {
      let truncate: (() => void) | undefined;
      const proxy = createServer((_request, response) => {
        response.writeHead(200, framing === "content-length" ? { "content-length": 10000 } : {});
        response.write("partial");
        truncate = () => response.destroy();
      });
      const proxyPort = await listen(proxy);
      const gateway = createCubeEgressGateway({
        poller: {
          current: {
            enabled: true,
            revision: 1,
            upstreamProxyUrl: new URL(`http://127.0.0.1:${proxyPort}`),
          },
        },
      });
      const gatewayPort = await listen(gateway);
      const outcome = Promise.withResolvers<string>();
      const outgoing = request(
        { host: "127.0.0.1", port: gatewayPort, path: "http://8.8.8.8/test" },
        (response) => {
          response.on("data", () => truncate!());
          response.once("error", () => outcome.resolve("truncated"));
          response.once("end", () => outcome.resolve("incorrect-success"));
        },
      );
      outgoing.once("error", outcome.reject);
      const deadline = setTimeout(
        () => outcome.reject(new Error("Downstream did not terminate")),
        2000,
      );
      try {
        outgoing.end();
        expect(await outcome.promise).toBe("truncated");
      } finally {
        clearTimeout(deadline);
        outgoing.destroy();
        gateway.closeAllConnections();
        proxy.closeAllConnections();
      }
    },
  );

  it("closes the upstream transfer when the downstream client disconnects", async () => {
    const closed = Promise.withResolvers<void>();
    const proxy = createServer((_request, response) => {
      response.once("close", () => closed.resolve());
      response.writeHead(200);
      response.write("still streaming");
    });
    const proxyPort = await listen(proxy);
    const gateway = createCubeEgressGateway({
      poller: {
        current: {
          enabled: true,
          revision: 1,
          upstreamProxyUrl: new URL(`http://127.0.0.1:${proxyPort}`),
        },
      },
    });
    const gatewayPort = await listen(gateway);
    const outgoing = request(
      { host: "127.0.0.1", port: gatewayPort, path: "http://8.8.8.8/test" },
      (response) => {
        response.once("data", () => outgoing.destroy());
        response.on("error", () => {});
      },
    );
    outgoing.on("error", () => {});
    const deadline = setTimeout(
      () => closed.reject(new Error("Upstream transfer remained open")),
      2000,
    );
    try {
      outgoing.end();
      await closed.promise;
    } finally {
      clearTimeout(deadline);
      outgoing.destroy();
      gateway.closeAllConnections();
      proxy.closeAllConnections();
    }
  });

  it("stays live but unready before its first durable configuration", async () => {
    const gateway = createCubeEgressGateway({ poller: { current: undefined } });
    const gatewayPort = await listen(gateway);
    await expect(throughGateway(gatewayPort, "/health/live")).resolves.toMatchObject({
      status: 200,
      body: '{"status":"ok","configured":false}\n',
    });
    await expect(throughGateway(gatewayPort, "/health/ready")).resolves.toMatchObject({
      status: 503,
      body: '{"status":"not_ready","configured":false}\n',
    });
  });

  it("hot-switches new requests without restarting and keeps DNS resolution out of the proxy", async () => {
    const firstPort = await upstream("first");
    const secondPort = await upstream("second");
    let current: CubeEgressRuntimeConfiguration = {
      enabled: true,
      upstreamProxyUrl: new URL(`http://127.0.0.1:${String(firstPort)}`),
      revision: 1,
    };
    const audits: CubeEgressAuditRecord[] = [];
    const gateway = createCubeEgressGateway({
      poller: {
        get current() {
          return current;
        },
      },
      audit: (record) => audits.push(record),
    });
    const gatewayPort = await listen(gateway);

    await expect(throughGateway(gatewayPort, "http://8.8.8.8/probe?a=1")).resolves.toEqual({
      status: 200,
      body: "first",
      target: "http://8.8.8.8:80/probe?a=1",
    });
    current = {
      enabled: true,
      upstreamProxyUrl: new URL(`http://127.0.0.1:${String(secondPort)}`),
      revision: 2,
    };
    await expect(throughGateway(gatewayPort, "http://8.8.8.8/probe?a=2")).resolves.toEqual({
      status: 200,
      body: "second",
      target: "http://8.8.8.8:80/probe?a=2",
    });
    expect(
      audits.filter(({ outcome }) => outcome === "allowed").map(({ revision }) => revision),
    ).toEqual([1, 2]);
  });

  it("rejects private targets before forwarding anything upstream", async () => {
    const upstreamPort = await upstream("must-not-be-reached");
    const gateway = createCubeEgressGateway({
      poller: {
        current: {
          enabled: true,
          upstreamProxyUrl: new URL(`http://127.0.0.1:${String(upstreamPort)}`),
          revision: 7,
        },
      },
    });
    const gatewayPort = await listen(gateway);
    await expect(throughGateway(gatewayPort, "http://127.0.0.1/private")).resolves.toMatchObject({
      status: 403,
      body: "",
    });
  });

  it("records one close outcome when both ends of a CONNECT tunnel close", async () => {
    const proxy = createServer();
    proxy.on("connect", (_request, socket) => {
      socket.end("HTTP/1.1 200 Connection Established\r\n\r\n");
    });
    const proxyPort = await listen(proxy);
    const audits: CubeEgressAuditRecord[] = [];
    const gateway = createCubeEgressGateway({
      poller: {
        current: {
          enabled: true,
          upstreamProxyUrl: new URL(`http://127.0.0.1:${String(proxyPort)}`),
          revision: 8,
        },
      },
      audit: (record) => audits.push(record),
    });
    const gatewayPort = await listen(gateway);

    await expect(throughConnect(gatewayPort, "8.8.8.8:443")).resolves.toContain(
      "200 Connection Established",
    );
    expect(audits.filter(({ outcome }) => outcome === "closed")).toHaveLength(1);
  });
});
