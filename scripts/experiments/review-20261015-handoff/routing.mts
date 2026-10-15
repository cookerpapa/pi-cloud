// Audit probes against current production adapters; no live PG, Kafka or Cube.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { ToolCommandDispatcher } from "../../../packages/sandbox-control/src/tool-command-dispatcher.ts";
import { SandboxBindingView } from "../../../packages/sandbox-control/src/sandbox-binding-view.ts";
import {
  CubeExecutionRejected,
  OfficialCubeSandboxRuntimeClient,
} from "../../../packages/sandbox-control/src/cubesandbox-runtime-client.ts";
import { toolInvocationFixture } from "../../../packages/runtime-core/test/tool-invocation-fixture.ts";
import { toolCommandsForFact } from "../../../packages/runtime-core/src/tool-invocation-fact.ts";
import { encodeSessionLogFact } from "../../../packages/runtime-core/src/session-log-envelope.ts";
import { decodeSessionLogFact } from "../../../packages/runtime-core/src/kafka-accepted-fact.ts";
import type { SandboxBindingRecord } from "../../../packages/sandbox-control/src/sandbox-bindings.ts";

const { fact } = toolInvocationFixture();
const command = toolCommandsForFact(fact)[0]!;
const multi = structuredClone(fact);
const secondWrite = structuredClone(multi.commit.writes[0]) as any;
secondWrite.value.id = 5;
secondWrite.value.input.callId = "provider-2";
multi.commit.writes.push(secondWrite);
multi.commit.nextId = 6;
multi.origins.push({ ...multi.origins[0]!, recordId: 5 });
multi.tools.push({
  ...structuredClone(multi.tools[0]!),
  taskId: 5,
  request: { ...multi.tools[0]!.request, operationId: randomUUID() },
});
const multiDecoded = decodeSessionLogFact(encodeSessionLogFact(multi));
assert.equal(multiDecoded.tools.length, 2);
const route: SandboxBindingRecord = {
  bindingId: command.request.activationId,
  tenantId: command.scope.tenantId,
  piSessionId: command.scope.piSessionId,
  runId: command.scope.runId,
  writerId: command.scope.writerId,
  revision: "1",
  instanceId: randomUUID(),
  baseUrl: "http://synthetic-controller.invalid",
  dispatchClosed: false,
  descriptor: {
    version: 1,
    target: {
      apiUrl: "http://127.0.0.1",
      sandboxId: "aabbccddeeff00112233445566778899",
      nodeId: "synthetic-node",
      bootId: randomUUID(),
    },
    // These opaque fields are never executed by the stubs in this audit.
    initialization: {} as SandboxBindingRecord["descriptor"]["initialization"],
  },
  snapshot: {} as SandboxBindingRecord["snapshot"],
};
const record = { topic: "synthetic-log", partition: 0, offset: 120n, fact: command };
function fixture(reason: string, quarantine: () => Promise<void>) {
  const replies: any[] = [];
  let submits = 0;
  const dispatcher = new ToolCommandDispatcher({
    routes: {
      find: async () => [route],
      closeWriter: async () => {},
      isAlive: async () => true,
    },
    cube: {
      submitTool: async () => {
        submits++;
        throw new CubeExecutionRejected(reason);
      },
      cancelTool: async () => {},
    },
    workflow: async () => {},
    publishReply: async (_topic, reply) => {
      replies.push(reply);
    },
    quarantine,
  });
  return { dispatcher, replies, submits: () => submits };
}

const classification = [];
for (const reason of [
  "node_unavailable",
  "execution_unavailable",
  "execution_endpoint_unconfigured",
  "capacity",
  "unrecognized_refusal",
]) {
  const f = fixture(reason, async () => {});
  await f.dispatcher.consume(record);
  assert.equal(f.submits(), 1);
  assert.equal(f.replies.length, 1);
  classification.push({ reason, ...f.replies[0].failure });
  await f.dispatcher.close();
}
assert.equal(classification.find((r) => r.reason === "node_unavailable")?.effect, "unknown");
assert.equal(
  classification.find((r) => r.reason === "unrecognized_refusal")?.effect,
  "not_started",
);

const q = fixture("executor_replaced", async () => {
  throw Error("synthetic quarantine propagation failure");
});
await assert.rejects(q.dispatcher.consume(record), /quarantine propagation/);
assert.equal(q.replies.length, 0);
assert.equal(q.submits(), 1);
await q.dispatcher.close();

const rows = Array.from({ length: 1000 }, () => ({ ...route, bindingId: randomUUID() }));
let reads = 0;
const view = new SandboxBindingView({
  partitionCount: 1,
  partitionFor: () => 0,
  source: {
    loadView: async ({ after }) => {
      const start = after ? rows.findIndex((r) => r.bindingId === after.bindingId) + 1 : 0;
      return rows.slice(start, start + 256);
    },
    readChange: async () => {
      reads++;
      return undefined;
    },
    closeWriter: async () => {},
    isAlive: async () => true,
  },
});
await view.load([0], () => true);
let entryLookups = 0;
const originalGet = Map.prototype.get;
Map.prototype.get = function (key: unknown) {
  if (typeof key === "string" && key.startsWith(`${route.tenantId}:${route.runId}:`))
    entryLookups++;
  return originalGet.call(this, key);
};
let found;
try {
  found = await view.find(command.scope);
} finally {
  Map.prototype.get = originalGet;
}
assert.equal(found.length, 1000);
assert.equal(entryLookups, 1000);
assert.equal(reads, 0);

// A real HTTP response sends its headers and then withholds the body. The
// production AbortSignal must still bound the complete takeover response.
let requests = 0;
let phase = "starting";
const sockets = new Set<import("node:net").Socket>();
const server = createServer((_req, res) => {
  requests++;
  res.writeHead(200, { "content-type": "application/json" });
  res.flushHeaders();
  res.write('{"accepted":');
});
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.once("close", () => sockets.delete(socket));
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert(address && typeof address !== "string");
const target = { ...route.descriptor.target, apiUrl: `http://127.0.0.1:${address.port}` };
const client = new OfficialCubeSandboxRuntimeClient({
  apiUrl: target.apiUrl,
  apiKey: "synthetic-review-key",
  proxyScheme: "http",
  sandboxDomain: "synthetic.invalid",
  egressProxyIp: "127.0.0.1",
  proxyNodeIp: "127.0.0.1",
});
const began = performance.now();
let bodyDeadlineMs = 0;
const watchdog = setTimeout(() => {
  console.error(JSON.stringify({ watchdog: true, phase, sockets: sockets.size }));
  server.close();
  for (const socket of sockets) socket.destroy();
}, 10_000);
phase = "request";
try {
  await assert.rejects(
    client.submitTool(target, {
      source: { topic: record.topic, partition: 0, offset: "120" },
      executionScopeId: route.bindingId,
      writerId: command.scope.writerId,
      operationId: command.request.operationId,
      payload: {},
      completionContext: {},
      timeoutMs: 1000,
      maximumOutputBytes: 1024,
    }),
  );
  bodyDeadlineMs = performance.now() - began;
  phase = "request-rejected";
  console.error(JSON.stringify({ phase, bodyDeadlineMs }));
} finally {
  // Stop accepting before destroying sockets: the HTTP pool can open a
  // replacement connection after abort. Such a socket is only fixture state.
  phase = "server-cleanup";
  const closed = new Promise<void>((resolve) => server.close(() => resolve()));
  server.closeAllConnections();
  for (const socket of sockets) socket.destroy();
  await closed;
  await client.close();
  clearTimeout(watchdog);
}
assert(bodyDeadlineMs >= 4500 && bodyDeadlineMs < 8000);
assert.equal(requests, 1);
const result = {
  baseline: "93635d37",
  multiCommandEnvelope: { decodedCommands: multiDecoded.tools.length, sharedKafkaRecord: true },
  classification,
  quarantineFailure: {
    submitCalls: q.submits(),
    failureReplies: q.replies.length,
    propagated: true,
  },
  bindingLookup: {
    familyBindings: rows.length,
    entryLookups,
    returnedRoutes: found.length,
    pgReads: reads,
  },
  partialHttpReply: { requests, bodyDeadlineMs, bounded: true },
};
await writeFile(
  process.argv[2] ?? "/tmp/pi-cloud-handoff-review-routing.json",
  JSON.stringify(result, null, 2) + "\n",
  { mode: 0o600 },
);
console.log(JSON.stringify(result));
