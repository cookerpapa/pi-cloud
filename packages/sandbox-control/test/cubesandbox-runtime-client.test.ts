import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { OfficialCubeSandboxRuntimeClient } from "../src/index.ts";
import {
  CubeExecutionRejected,
  CubeApplicationPortError,
} from "../src/cubesandbox-runtime-client.ts";
import { MAX_IMAGE_GUEST_RESPONSE_BYTES } from "@pi-cloud/protocol";

type ObservedRequest = {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: unknown;
};

let server: Server;
let port: number;
const observed: ObservedRequest[] = [];
let runtimeState: string | undefined = "running";
let pauseReturnsTimeout = false;
let observationMode: "present" | "absent" | "unavailable" | "missing-endpoint" | "wrong-node" =
  "present";
let executionReply: unknown = {};
let executionStatus = 200;
let tcpResponse: ServerResponse | undefined;
let tcpConnectMode: "connected" | "refused" | "unreachable" = "connected";
beforeEach(() => {
  observed.length = 0;
  executionTarget.apiUrl = `http://127.0.0.1:${port}`;
  executionReply = {};
  executionStatus = 200;
  runtimeState = "running";
  observationMode = "present";
  tcpConnectMode = "connected";
});

it("uses the same native probe endpoint for direct guest evidence and asynchronous mailbox delivery", async () => {
  const client = executionClient();
  const probeId = "10000000-0000-4000-8000-000000000099",
    guestBootId = "10000000-0000-4000-8000-000000000098";
  try {
    executionReply = {
      accepted: true,
      bootID: executionTarget.bootId,
      probeID: probeId,
      output: { type: "worker.probe_result", probeId, guestBootId },
    };
    await expect(client.probeExecution(executionTarget, probeId)).resolves.toMatchObject({
      probeId,
      guestBootId,
    });
    expect(observed.at(-1)?.path).toContain("/execution/probe");
    expect(observed.at(-1)?.body).not.toHaveProperty("completionContext");
    executionReply = { accepted: true, bootID: executionTarget.bootId, probeID: probeId };
    await client.submitProbe(executionTarget, {
      probeId,
      runId: "run",
      writerId: "writer",
      completionContext: { kind: "execution_probe" },
    });
    expect(observed.at(-1)?.body).toMatchObject({
      runID: "run",
      writerID: "writer",
      completionContext: { kind: "execution_probe" },
    });
    executionReply = { accepted: true, bootID: "replaced", probeID: probeId };
    await expect(client.probeExecution(executionTarget, probeId)).rejects.toThrow("identity");
    executionReply = { accepted: false, rejection: "node_unavailable" };
    await expect(client.probeExecution(executionTarget, probeId)).rejects.toMatchObject({
      code: "node_unavailable",
    });
  } finally {
    await client.close();
  }
});

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
      if (request.url?.startsWith("/sandboxes/aabbccddeeff00112233445566778899/observation?")) {
        if (observationMode === "missing-endpoint") {
          response.writeHead(404).end();
          return;
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            sandboxID: "aabbccddeeff00112233445566778899",
            nodeID: observationMode === "wrong-node" ? "another-node" : "node-1",
            presence: observationMode === "wrong-node" ? "absent" : observationMode,
            state: observationMode === "present" ? runtimeState : "unknown",
          }),
        );
        return;
      }
      if (request.url?.includes("/execution/")) {
        response.writeHead(executionStatus, { "content-type": "application/json" });
        response.end(JSON.stringify(executionReply));
        return;
      }
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
        if (request.url === "/process.Process/Start") {
          response.writeHead(200, { "content-type": "application/connect+json" });
          if (typeof body === "object" && body !== null && "stdin" in body && body.stdin === true) {
            tcpResponse = response;
            response.write(connectFrame({ event: { start: { pid: 74 } } }));
            if (tcpConnectMode === "unreachable") {
              response.end(connectFrame({ event: { end: { exitCode: 127 } } }));
              return;
            }
            if (tcpConnectMode === "refused") {
              response.end(
                connectFrame({
                  event: {
                    data: { stderr: Buffer.from("PI_CLOUD_TCP_FAILED\n").toString("base64") },
                  },
                }),
              );
              return;
            }
            response.write(
              connectFrame({
                event: {
                  data: { stderr: Buffer.from("PI_CLOUD_TCP_CONNECTED\n").toString("base64") },
                },
              }),
            );
            return;
          }
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
          const input = body as { input?: { stdin?: string }; signal?: string };
          if (input.input?.stdin)
            tcpResponse?.write(connectFrame({ event: { data: { stdout: input.input.stdin } } }));
          if (input.signal && tcpResponse) {
            tcpResponse.end(connectFrame({ event: { end: { exitCode: 0 } } }));
            tcpResponse = undefined;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end("{}");
          return;
        }
        response.writeHead(404);
        response.end();
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
      if (
        request.method === "DELETE" &&
        request.url === "/volumes/pcw-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
      ) {
        response.writeHead(204);
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
            clientID: "20000000-0000-4000-8000-000000000001",
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
            clientID: "20000000-0000-4000-8000-000000000002",
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
            clientID: "cube-node-1",
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
              clientID: "cube-node-1",
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
  it("resolves node identity from details rather than create/connect client UUIDs", async () => {
    const client = executionClient();
    try {
      const created = await client.create({
        templateId: "pi-cloud-tool-v1",
        timeoutSeconds: 60,
        metadata: {},
        allowInternetAccess: true,
        allowPublicTraffic: false,
      });
      expect(created.nodeId).toBeUndefined();
      expect((await client.read(created.sandboxId))?.nodeId).toBe("cube-node-1");
      expect((await client.connect(created.sandboxId, -1)).nodeId).toBeUndefined();
    } finally {
      await client.close();
    }
  });
  it.each(["present", "absent", "unavailable", "missing-endpoint", "wrong-node"] as const)(
    "requires exact node evidence before accepting absence (%s)",
    async (mode) => {
      const client = new OfficialCubeSandboxRuntimeClient({
        apiUrl: `http://127.0.0.1:${port}`,
        apiKey: "k".repeat(48),
        proxyNodeIp: "127.0.0.1",
        proxyPort: port,
        proxyScheme: "http",
        sandboxDomain: "cube.test",
        egressProxyIp: "10.255.255.254",
      });
      observationMode = mode;
      runtimeState = "stopped";
      try {
        expect(await client.observe("aabbccddeeff00112233445566778899", "node-1")).toEqual({
          runtimeName: "aabbccddeeff00112233445566778899",
          nodeId: "node-1",
          presence: mode === "absent" || mode === "present" ? mode : "unavailable",
          state: mode === "present" ? "stopped" : "unknown",
        });
        expect(observed[0]?.path).toContain("nodeID=node-1");
      } finally {
        await client.close();
      }
    },
  );
  it.each([
    "running",
    "paused",
    "pausing",
    "stopped",
    "error",
    "unknown",
    "future-state",
    undefined,
  ])("preserves node identity and does not infer running from state %s", async (state) => {
    const client = new OfficialCubeSandboxRuntimeClient({
      apiUrl: `http://127.0.0.1:${port}`,
      apiKey: "k".repeat(48),
      proxyNodeIp: "127.0.0.1",
      proxyPort: port,
      proxyScheme: "http",
      sandboxDomain: "cube.test",
      egressProxyIp: "10.255.255.254",
    });
    runtimeState = state;
    try {
      const expected = !state || state === "future-state" ? "unknown" : state;
      await expect(client.read("cube-runtime-1")).resolves.toMatchObject({
        state: expected,
        nodeId: "cube-node-1",
      });
      expect((await client.list())[0]).toMatchObject({ state: expected, nodeId: "cube-node-1" });
    } finally {
      await client.close();
    }
  });
  it.each(["refused", "unreachable"] as const)(
    "does not ACK a preview when the application is %s",
    async (mode) => {
      const client = new OfficialCubeSandboxRuntimeClient({
        apiUrl: `http://127.0.0.1:${port}`,
        apiKey: "k".repeat(48),
        proxyNodeIp: "127.0.0.1",
        proxyPort: port,
        proxyScheme: "http",
        sandboxDomain: "cube.test",
        egressProxyIp: "10.255.255.254",
      });
      tcpConnectMode = mode;
      try {
        const instance = await client.create({
          templateId: "pi-cloud-tool-v1",
          timeoutSeconds: 900,
          metadata: {},
          allowInternetAccess: true,
          allowPublicTraffic: false,
        });
        const error = await client.openTcp(instance, 4173).then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(error).toBeInstanceOf(Error);
        expect(error instanceof CubeApplicationPortError).toBe(mode === "refused");
        await vi.waitFor(() =>
          expect(observed).toContainEqual(
            expect.objectContaining({
              path: "/process.Process/SendSignal",
              body: { process: { pid: 74 }, signal: "SIGNAL_SIGKILL" },
            }),
          ),
        );
      } finally {
        tcpConnectMode = "connected";
        await client.close();
      }
    },
  );
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
    await expect(client.deleteVolume(volumeId)).resolves.toBeUndefined();
    expect(
      observed.find(
        (request) => request.method === "DELETE" && request.path === `/volumes/${volumeId}`,
      ),
    ).toBeDefined();
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
    const imageStream: Buffer[] = [];
    await expect(
      client.runCommand(instance, {
        command: "read image fixture",
        cwd: "/workspace",
        user: "root",
        timeoutMs: 1000,
        maximumOutputBytes: MAX_IMAGE_GUEST_RESPONSE_BYTES,
        onStdout: async (bytes) => {
          imageStream.push(bytes);
        },
      }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(Buffer.concat(imageStream).toString()).toBe("envd command\n");
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
    const temporaryGuestPath = "/tmp/pi-cloud-envd-10000000-0000-4000-8000-000000000001.json";
    await client.writeGuestFile(instance, temporaryGuestPath, Buffer.from("{}"));
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
    const tcp = await client.openTcp(instance, 4173);
    const echoed = new Promise<Buffer>((resolve) => tcp.once("data", resolve));
    tcp.write(Buffer.from([0, 255, 13, 10]));
    expect(await echoed).toEqual(Buffer.from([0, 255, 13, 10]));
    const tcpStart = observed.filter((request) => request.path === "/process.Process/Start").at(-1);
    expect(tcpStart?.body).toMatchObject({ stdin: true, process: { cmd: "/usr/bin/setpriv" } });
    expect(JSON.stringify(tcpStart?.body)).not.toContain("private-traffic-token");
    expect(JSON.stringify(tcpStart?.body)).not.toContain('"pty"');
    await new Promise<void>((resolve) => {
      tcp.once("close", resolve);
      tcp.end();
      tcp.resume();
    });
    await expect(client.openTcp(instance, 49983)).rejects.toThrow("Invalid application port");
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

const executionTarget = {
  apiUrl: "",
  sandboxId: "aabbccddeeff00112233445566778899",
  nodeId: "node-1",
  bootId: "11111111-1111-4111-8111-111111111111",
};
const executionRequest = {
  source: { topic: "test-session-log", partition: 0, offset: "1" },
  operationId: "22222222-2222-4222-8222-222222222222",
  runId: "33333333-3333-4333-8333-333333333333",
  writerId: "44444444-4444-4444-8444-444444444444",
  payload: {},
  completionContext: {},
  timeoutMs: 1000,
  maximumOutputBytes: 1024,
};
function executionClient() {
  return new OfficialCubeSandboxRuntimeClient({
    apiUrl: `http://127.0.0.1:${port}`,
    apiKey: "test-api-key",
    proxyNodeIp: "127.0.0.1",
    proxyPort: port,
    proxyScheme: "http",
    sandboxDomain: "cube.internal",
    egressProxyIp: "127.0.0.1",
  });
}
it("accepts only a handoff for the recorded executor boot and operation", async () => {
  const client = executionClient();
  try {
    executionReply = {
      accepted: true,
      bootID: executionTarget.bootId,
      operationID: executionRequest.operationId,
    };
    await client.submitTool(executionTarget, executionRequest);
    expect(observed.at(-1)?.body).toMatchObject({
      nodeID: "node-1",
      bootID: executionTarget.bootId,
      operationID: executionRequest.operationId,
    });
    executionReply = {
      accepted: true,
      bootID: "wrong-boot",
      operationID: executionRequest.operationId,
    };
    await expect(client.submitTool(executionTarget, executionRequest)).rejects.not.toBeInstanceOf(
      CubeExecutionRejected,
    );
  } finally {
    await client.close();
  }
});
it("distinguishes explicit refusal from an ambiguous HTTP or identity failure", async () => {
  const client = executionClient();
  try {
    executionReply = {
      accepted: false,
      operationID: executionRequest.operationId,
      rejection: "execution_position_stale",
    };
    await expect(client.submitTool(executionTarget, executionRequest)).rejects.toBeInstanceOf(
      CubeExecutionRejected,
    );
    executionStatus = 502;
    await expect(client.submitTool(executionTarget, executionRequest)).rejects.not.toBeInstanceOf(
      CubeExecutionRejected,
    );
    executionStatus = 200;
    executionReply = {
      accepted: false,
      operationID: "another-operation",
      rejection: "execution_position_stale",
    };
    await expect(client.submitTool(executionTarget, executionRequest)).rejects.not.toBeInstanceOf(
      CubeExecutionRejected,
    );
  } finally {
    await client.close();
  }
});
it("never treats a replaced boot's stopping response as proof", async () => {
  const client = executionClient();
  try {
    executionReply = { stopped: true, bootID: "another-boot" };
    await expect(
      client.stopExecutionScope(executionTarget, {
        runId: executionRequest.runId,
        source: executionRequest.source,
      }),
    ).rejects.toThrow("could not be confirmed");
    executionReply = { stopped: true, bootID: executionTarget.bootId };
    await client.stopExecutionScope(executionTarget, {
      runId: executionRequest.runId,
      source: executionRequest.source,
    });
  } finally {
    await client.close();
  }
});

it("does not forward Cube credentials to an unconfigured descriptor endpoint", async () => {
  const client = executionClient();
  try {
    await expect(
      client.submitTool({ ...executionTarget, apiUrl: "http://127.0.0.1:1" }, executionRequest),
    ).rejects.toMatchObject({ code: "execution_endpoint_unconfigured" });
    expect(observed).toEqual([]);
  } finally {
    await client.close();
  }
});
it("routes a recorded endpoint through the deployment-owned credential registry", async () => {
  const remoteUrl = `http://localhost:${port}`;
  const client = new OfficialCubeSandboxRuntimeClient({
    apiUrl: `http://127.0.0.1:${port}`,
    apiKey: "primary-key",
    executionEndpoints: [{ apiUrl: remoteUrl, apiKey: "remote-key" }],
    proxyNodeIp: "127.0.0.1",
    proxyPort: port,
    proxyScheme: "http",
    sandboxDomain: "cube.internal",
    egressProxyIp: "127.0.0.1",
  });
  try {
    executionReply = {
      accepted: true,
      bootID: executionTarget.bootId,
      operationID: executionRequest.operationId,
    };
    await client.submitTool({ ...executionTarget, apiUrl: remoteUrl }, executionRequest);
    expect(observed.at(-1)?.headers.authorization).toBe("Bearer remote-key");
  } finally {
    await client.close();
  }
});
