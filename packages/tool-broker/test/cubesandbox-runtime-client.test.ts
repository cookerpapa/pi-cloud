import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OfficialCubeSandboxRuntimeClient } from "../src/index.ts";

type ObservedRequest = {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
};

let server: Server;
let port: number;
const observed: ObservedRequest[] = [];
let runtimeState = "running";
let pauseReturnsTimeout = false;

function connectFrame(value: unknown, flags = 0): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(5);
  header.writeUInt8(flags, 0);
  header.writeUInt32BE(payload.byteLength, 1);
  return Buffer.concat([header, payload]);
}

beforeAll(async () => {
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const bytes = Buffer.concat(chunks);
      const contentType = request.headers["content-type"] ?? "";
      const body =
        bytes.byteLength === 0
          ? undefined
          : contentType.includes("application/connect+json")
            ? (JSON.parse(bytes.subarray(5).toString("utf8")) as unknown)
            : contentType.includes("application/octet-stream")
              ? bytes
              : (JSON.parse(bytes.toString("utf8")) as unknown);
      observed.push({
        method: request.method ?? "",
        path: request.url ?? "",
        headers: request.headers,
        body,
      });
      const host = request.headers.host ?? "";
      if (request.url === "/health") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"status":"ok"}');
        return;
      }
      if (host.startsWith("49983-cube-runtime-1.")) {
        if (request.url?.startsWith("/files?") === true) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end("[]");
          return;
        }
        if (request.url === "/filesystem.Filesystem/ListDir") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ entries: [] }));
          return;
        }
        if (request.url === "/filesystem.Filesystem/MakeDir") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ entry: { type: "FILE_TYPE_DIRECTORY" } }));
          return;
        }
        if (request.url === "/filesystem.Filesystem/Remove") {
          response.writeHead(200, { "content-type": "application/json" });
          response.end("{}");
          return;
        }
        if (request.url === "/process.Process/Start") {
          response.writeHead(200, { "content-type": "application/connect+json" });
          if (typeof body === "object" && body !== null && "pty" in body) {
            response.write(connectFrame({ event: { start: { pid: 73 } } }));
            response.write(
              connectFrame({
                event: { data: { pty: Buffer.from("cube shell\r\n").toString("base64") } },
              }),
            );
            response.end(connectFrame({ event: { end: { exitCode: 0 } } }));
          } else {
            response.write(
              connectFrame({
                event: { data: { stdout: Buffer.from("envd command\n").toString("base64") } },
              }),
            );
            response.end(connectFrame({ event: { end: { exitCode: 0 } } }));
          }
          return;
        }
        if (request.url?.startsWith("/process.Process/") === true) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end("{}");
          return;
        }
        response.writeHead(404);
        response.end();
        return;
      }
      if (host.startsWith("5173-cube-runtime-1.")) {
        response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        response.end("<html>private-preview-ok</html>");
        return;
      }
      if (
        request.method === "GET" &&
        request.url === "/volumes/pcw-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      ) {
        response.writeHead(404);
        response.end();
        return;
      }
      if (request.method === "POST" && request.url === "/volumes") {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            volumeID: (body as { name?: unknown }).name,
            name: (body as { name?: unknown }).name,
          }),
        );
        return;
      }
      if (request.method === "POST" && request.url === "/sandboxes") {
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            sandboxID: "cube-runtime-1",
            templateID: "pi-cloud-tool-v1",
            state: runtimeState,
            domain: "cube.test",
            metadata: (body as { metadata?: unknown }).metadata,
            trafficAccessToken: "private-traffic-token",
            envdAccessToken: "envd-access-token",
            cpuCount: 1,
            memoryMB: 768,
          }),
        );
        return;
      }
      if (request.method === "POST" && request.url === "/sandboxes/cube-runtime-1/pause") {
        if (pauseReturnsTimeout) {
          pauseReturnsTimeout = false;
          runtimeState = "pausing";
          setTimeout(() => {
            runtimeState = "paused";
          }, 25);
          response.writeHead(408);
          response.end();
          return;
        }
        runtimeState = "paused";
        response.writeHead(204);
        response.end();
        return;
      }
      if (request.method === "POST" && request.url === "/sandboxes/cube-runtime-1/connect") {
        runtimeState = "running";
        response.writeHead(201, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            sandboxID: "cube-runtime-1",
            templateID: "pi-cloud-tool-v1",
            state: runtimeState,
            domain: "cube.test",
            metadata: { "picloud.managed": "true" },
            trafficAccessToken: "private-traffic-token-resumed",
            envdAccessToken: "envd-access-token",
          }),
        );
        return;
      }
      if (request.method === "GET" && request.url === "/sandboxes/cube-runtime-1") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            sandboxID: "cube-runtime-1",
            templateID: "pi-cloud-tool-v1",
            state: runtimeState,
            domain: "cube.test",
            metadata: { "picloud.managed": "true" },
          }),
        );
        return;
      }
      if (request.method === "GET" && request.url === "/v2/sandboxes?limit=1000") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify([
            {
              sandboxID: "cube-runtime-1",
              templateID: "pi-cloud-tool-v1",
              state: runtimeState,
              domain: "cube.test",
              metadata: { "picloud.managed": "true" },
            },
          ]),
        );
        return;
      }
      if (request.method === "DELETE" && request.url === "/sandboxes/cube-runtime-1") {
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

describe("official CubeSandbox HTTP compatibility client", () => {
  it("reconciles an HTTP 408 pause from the eventual physical state", async () => {
    runtimeState = "running";
    pauseReturnsTimeout = true;
    const client = new OfficialCubeSandboxRuntimeClient({
      apiUrl: `http://127.0.0.1:${String(port)}`,
      apiKey: "k".repeat(48),
      proxyNodeIp: "127.0.0.1",
      proxyPort: port,
      proxyScheme: "http",
      sandboxDomain: "cube.test",
      egressProxyIp: "10.255.255.254",
      requestTimeoutMs: 2_000,
    });
    await expect(client.pause("cube-runtime-1")).resolves.toBeUndefined();
    await expect(client.read("cube-runtime-1")).resolves.toMatchObject({ state: "paused" });
    await client.close();
  });

  it("allows public egress, denies private ranges and authenticates private ingress", async () => {
    runtimeState = "running";
    const client = new OfficialCubeSandboxRuntimeClient({
      apiUrl: `http://127.0.0.1:${String(port)}`,
      apiKey: "k".repeat(48),
      proxyNodeIp: "127.0.0.1",
      proxyPort: port,
      proxyScheme: "http",
      sandboxDomain: "cube.test",
      egressProxyIp: "10.255.255.254",
      directPrivateCidrs: ["192.168.31.0/24"],
    });
    await client.checkHealth();
    expect(observed.find((request) => request.path === "/health")).toMatchObject({
      headers: { authorization: `Bearer ${"k".repeat(48)}` },
    });
    const volumeId = `pcw-${"a".repeat(48)}`;
    await expect(client.ensureVolume(volumeId, "picloud-posix")).resolves.toEqual({
      volumeId,
      name: volumeId,
    });
    expect(observed.find((request) => request.path === "/volumes")).toMatchObject({
      method: "POST",
      headers: { authorization: `Bearer ${"k".repeat(48)}` },
      body: { name: volumeId, driver: "picloud-posix" },
    });
    const instance = await client.create({
      templateId: "pi-cloud-tool-v1",
      timeoutSeconds: 900,
      metadata: { "picloud.managed": "true" },
      allowInternetAccess: true,
      allowPublicTraffic: false,
      volumeMounts: [{ name: volumeId, path: "/workspace" }],
    });
    expect(instance.trafficAccessToken).toBe("private-traffic-token");
    expect(instance.envdAccessToken).toBe("envd-access-token");
    expect(observed.find((request) => request.path === "/sandboxes")).toMatchObject({
      headers: { authorization: `Bearer ${"k".repeat(48)}` },
      body: {
        templateID: "pi-cloud-tool-v1",
        timeout: 900,
        allow_internet_access: true,
        network: {
          allowPublicTraffic: false,
          allowOut: ["10.255.255.254/32", "192.168.31.0/24"],
          denyOut: ["0.0.0.0/0"],
        },
        lifecycle: { on_timeout: "kill", auto_resume: false },
        volumeMounts: [{ name: volumeId, path: "/workspace" }],
      },
    });
    await expect(
      client.runCommand(instance, {
        command: "printf 'envd command\\n'",
        cwd: "/workspace",
        user: "root",
        timeoutMs: 1_000,
        maximumOutputBytes: 64 * 1_024,
      }),
    ).resolves.toEqual({ stdout: "envd command\n", stderr: "", exitCode: 0 });
    const dataRequest = observed.find((request) => request.path === "/process.Process/Start");
    expect(dataRequest).toMatchObject({
      headers: {
        host: "49983-cube-runtime-1.cube.test",
        "e2b-traffic-access-token": "private-traffic-token",
        "cube-traffic-access-token": "private-traffic-token",
        "x-access-token": "envd-access-token",
        authorization: `Basic ${Buffer.from("root:").toString("base64")}`,
      },
    });
    await client.writeGuestFile(instance, "/tmp/input.json", Buffer.from("{}"));
    await expect(client.listGuestDirectory(instance, "/tmp")).resolves.toEqual([]);
    await expect(client.createGuestDirectory(instance, "/tmp/new")).resolves.toMatchObject({
      type: "FILE_TYPE_DIRECTORY",
    });
    await client.removeGuestFile(instance, "/tmp/input.json");
    await expect(
      client.requestService!(instance, {
        port: 5173,
        method: "GET",
        path: "/",
        headers: { accept: "text/html" },
        maximumResponseBytes: 64 * 1_024,
        timeoutMs: 1_000,
      }),
    ).resolves.toMatchObject({
      status: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: Buffer.from("<html>private-preview-ok</html>"),
    });
    expect(
      observed.find((request) => request.path === "/" && request.headers.host?.startsWith("5173-")),
    ).toMatchObject({
      headers: {
        host: "5173-cube-runtime-1.cube.test",
        "e2b-traffic-access-token": "private-traffic-token",
        "cube-traffic-access-token": "private-traffic-token",
      },
    });
    expect(
      observed.find((request) => request.path === "/" && request.headers.host?.startsWith("5173-"))
        ?.headers["x-access-token"],
    ).toBeUndefined();
    const terminal = await client.openTerminal(instance, {
      rows: 24,
      cols: 100,
      admin: false,
    });
    expect(terminal.pid).toBe(73);
    const output: Buffer[] = [];
    for await (const chunk of terminal.output) output.push(Buffer.from(chunk));
    expect(Buffer.concat(output).toString("utf8")).toBe("cube shell\r\n");
    await terminal.sendInput(Buffer.from("pwd\r"));
    await terminal.resize({ rows: 40, cols: 120 });
    await terminal.kill();
    const start = observed.filter((request) => request.path === "/process.Process/Start").at(-1);
    expect(start).toMatchObject({
      headers: {
        host: "49983-cube-runtime-1.cube.test",
        "e2b-traffic-access-token": "private-traffic-token",
        "cube-traffic-access-token": "private-traffic-token",
        "x-access-token": "envd-access-token",
        authorization: `Basic ${Buffer.from("root:").toString("base64")}`,
      },
    });
    expect(start?.body).toMatchObject({
      process: { cmd: "/usr/bin/setpriv", args: expect.arrayContaining(["--reuid", "1000"]) },
      pty: { size: { rows: 24, cols: 100 } },
    });
    expect(observed.find((request) => request.path === "/process.Process/SendInput")).toMatchObject(
      {
        body: { process: { pid: 73 }, input: { pty: Buffer.from("pwd\r").toString("base64") } },
      },
    );
    expect(observed.find((request) => request.path === "/process.Process/Update")).toMatchObject({
      body: { process: { pid: 73 }, pty: { size: { rows: 40, cols: 120 } } },
    });
    await expect(client.read(instance.sandboxId)).resolves.toMatchObject({
      sandboxId: "cube-runtime-1",
      metadata: { "picloud.managed": "true" },
    });
    await expect(client.list()).resolves.toHaveLength(1);
    await client.pause(instance.sandboxId);
    await expect(client.read(instance.sandboxId)).resolves.toMatchObject({ state: "paused" });
    await expect(client.connect(instance.sandboxId, -1)).resolves.toMatchObject({
      sandboxId: instance.sandboxId,
      state: "running",
      trafficAccessToken: "private-traffic-token-resumed",
    });
    expect(observed.find((request) => request.path.endsWith("/connect"))).toMatchObject({
      body: { timeout: -1 },
    });
    await client.destroy(instance.sandboxId);
    await client.close();
  });
});
