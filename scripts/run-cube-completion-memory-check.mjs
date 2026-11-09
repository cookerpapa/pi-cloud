// Isolated HTTPS completion-memory fixture: real TLS/parser/codec, delayed blob sink.
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
const root = fileURLToPath(new URL("..", import.meta.url)),
  require = createRequire(root + "/package.json");
const sharp = require("sharp");
const { processImageSource } = await import(root + "/packages/tool-sandbox/src/image-processor.ts");
const { ImageAttachmentCodec } = await import(root + "/packages/session-attachments/src/codec.ts");
const { CubeCompletionAdapter } = await import(root + "/packages/cube-completion/src/adapter.ts");
const { completionServer } = await import(root + "/packages/cube-completion/src/http-server.ts");
const { testTls } = await import(root + "/packages/cube-completion/test/tls-fixture.ts");
const { ToolCompletionCapabilities } = await import(
  root + "/packages/protocol/src/completion-capability.ts"
);
const { GuestCompletionClient } = await import(
  root + "/packages/tool-sandbox/src/completion-client.ts"
);
const count = Number(process.argv[2] ?? 8);
if (!Number.isSafeInteger(count) || count < 1 || count > 32)
  throw new Error("Fixture concurrency must be 1-32");
const png = await sharp(randomBytes(1600 * 1600 * 4), {
  raw: { width: 1600, height: 1600, channels: 4 },
})
  .png()
  .toBuffer();
const processed = await processImageSource(png, { autoResizeImages: true });
if (!processed.ok) throw Error(processed.message);
const expectedConcurrent = Math.min(
  count,
  32,
  Math.floor((256 * 1024 * 1024) / (processed.data.length + 16384)),
);
if (expectedConcurrent < 1) throw Error("One normalized image exceeds callback admission");
const held = Promise.withResolvers(),
  allReceived = Promise.withResolvers();
let received = 0,
  publications = 0,
  storedBytes = 0;
const before = process.memoryUsage().rss;
const images = new ImageAttachmentCodec({
  put: async (_scope, bytes, mimeType) => {
    storedBytes += bytes.length;
    if (++received === expectedConcurrent) allReceived.resolve();
    await held.promise;
    return {
      id: randomUUID(),
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      mimeType,
    };
  },
  get: async () => {
    throw Error("Not used");
  },
});
const adapter = new CubeCompletionAdapter({
  images,
  progress: { update() {}, forget() {} },
  publish: async (_topic, reply) => {
    if (reply.kind !== "tool_result" || reply.result.result.content[0].type !== "pi_cloud_image_v1")
      throw Error("Expected claim-check");
    publications++;
  },
});
const tls = await testTls();
const authority = new ToolCompletionCapabilities(randomBytes(32).toString("hex"));
const server = completionServer({ ...tls, authority, adapter, ready: async () => {} });
await server.listen({ host: "127.0.0.1", port: 0 });
const port = server.server.address().port;
const tasks = [];
try {
  for (let i = 0; i < count; i++) {
    const op = randomUUID(),
      call = "call-" + i;
    const packet = {
      id: randomUUID(),
      kind: "result",
      operationId: op,
      context: {
        scope: {
          tenantId: randomUUID(),
          sessionId: randomUUID(),
          piSessionId: randomUUID(),
          runId: randomUUID(),
          turnId: randomUUID(),
          writerId: randomUUID(),
          leaseId: randomUUID(),
          fencingToken: 1,
        },
        replyTopic: "fixture",
        toolCallId: call,
        nativeToolCallId: call,
        toolName: "read",
        partition: 0,
      },
      result: {
        output: {
          toolWorkerProtocolVersion: 7,
          type: "worker.operation_result",
          scopeStopRequired: false,
          response: {
            toolBrokerProtocolVersion: 1,
            type: "tool_sandbox.operation_result",
            activationId: randomUUID(),
            operationId: op,
            operation: "tool.execute",
            event: {
              type: "tool_execution_end",
              toolCallId: call,
              toolName: "read",
              isError: false,
              result: {
                content: [{ type: "image", data: processed.data, mimeType: processed.mimeType }],
              },
            },
          },
        },
      },
    };
    const expiresAt = Date.now() + 60_000;
    const client = new GuestCompletionClient(
      {
        url: `https://localhost:${port}/v1/completions`,
        address: "127.0.0.1",
        ca: tls.cert,
        expiresAt,
        capability: authority.issue({
          operationId: op,
          issuer: "guest",
          expiresAt,
          context: packet.context,
        }),
      },
      op,
    );
    const task = client.complete(packet.result.output);
    void task.catch(() => {});
    tasks.push(task);
  }
  await Promise.race([
    allReceived.promise,
    new Promise((_, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("HTTPS admission did not reach the blob sink")),
        45000,
      );
      timeout.unref();
    }),
  ]);
  const blockedRss = process.memoryUsage().rss;
  held.resolve();
  await Promise.all(tasks);
  const report = {
    count,
    expectedConcurrent,
    base64Bytes: processed.data.length,
    storedBytes,
    publications,
    rssBeforeBytes: before,
    rssWhileUploadsBlockedBytes: blockedRss,
    peakRssBytes:
      Number((await readFile("/proc/self/status", "utf8")).match(/^VmHWM:\s+(\d+)/m)[1]) * 1024,
    scope:
      "Actual HTTPS admission/Guest callback/adapter/codec; normalized synthetic high image; delayed in-memory blob sink and reply sink, no real S3/Kafka/VM or aggregate host-memory bound",
  };
  if (process.argv[3]) await writeFile(process.argv[3], JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
} finally {
  held.resolve();
  await Promise.allSettled(tasks);
  await server.close();
}
