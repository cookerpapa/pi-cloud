import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { testKafka } from "./lib/test-kafka.mjs";
import { KafkaToolReplyMailbox, KafkaToolReplyPublisher } from "../packages/event-log/src/index.ts";
import { ANDROID_CAPABILITIES } from "../packages/protocol/src/index.ts";
import { AppiumAndroidDriver } from "../packages/android-executor/src/appium-driver.ts";
import { AndroidExecutionManager } from "../packages/android-executor/src/execution-manager.ts";
import { createExecutorServer } from "../packages/android-executor/src/server.ts";
import { HttpExecutorTransport } from "../packages/sandbox-control/src/executor-transport.ts";
import { ImageAttachmentCodec } from "../packages/session-attachments/src/codec.ts";
import { GuestCompletionClient } from "../packages/workspace-runtime/src/tool-completion-client.ts";
import { CubeCompletionAdapter } from "../packages/cube-completion/src/adapter.ts";
import { completionServer } from "../packages/cube-completion/src/http-server.ts";
import { ToolCompletionCapabilities } from "../packages/protocol/src/completion-capability.ts";
import { testTls } from "../packages/cube-completion/test/tls-fixture.ts";

// This checks actual Android + RF3 transport. Attachment bytes use an owned
// in-memory test store; production S3/native history is verified after rollout.
if (process.env.PI_CLOUD_ANDROID_TRANSPORT_CHECK !== "1")
  throw Error("Set PI_CLOUD_ANDROID_TRANSPORT_CHECK=1 for the owned emulator");
const appium = process.env.PI_CLOUD_APPIUM_URL;
if (!appium) throw Error("Set the owned Appium endpoint");
const out = resolve(process.argv[2] ?? "dist/android-transport.json");
await mkdir(resolve(out, ".."), { recursive: true });
const kafka = await testKafka();
const mailbox = new KafkaToolReplyMailbox({
  brokers: kafka.brokers,
  replicas: 3,
  bootId: randomUUID(),
});
const publisher = new KafkaToolReplyPublisher(kafka.brokers, "android-acceptance-" + randomUUID());
const driver = new AppiumAndroidDriver({ url: appium, udid: "127.0.0.1:6520", systemPort: 8200 });
const images = new Map();
const codec = new ImageAttachmentCodec({
  async put(scope, bytes, mimeType) {
    const id = randomUUID();
    images.set(scope.tenantId + id, Buffer.from(bytes));
    return {
      id,
      mimeType,
      byteLength: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  },
  async get(tenant, ref) {
    const bytes = images.get(tenant + ref.id);
    if (!bytes) throw Error("Missing fixture image");
    return bytes;
  },
});
const token = randomUUID(),
  targetId = randomUUID(),
  bootId = randomUUID();
let server, manager, completion;
const transport = new HttpExecutorTransport(token);
const report = { at: new Date().toISOString(), passed: false, replyCount: 0 };
try {
  await mailbox.start();
  await publisher.start();
  await driver.open();
  manager = new AndroidExecutionManager({
    targetId,
    bootId,
    ready: () => driver.ready,
    execute: (n, a, s) => driver.execute(n, a, s),
    complete: (call, output) =>
      new GuestCompletionClient(call.completion, call.operationId).complete(output),
  });
  server = createExecutorServer({
    token,
    manager,
    ready: () => driver.ready,
    screenshot: (s) => driver.screenshot(s),
  });
  const endpoint = await server.listen({ host: "127.0.0.1", port: 0 });
  const binding = {
    targetId,
    bootId,
    bindingId: randomUUID(),
    generation: "1",
    tenantId: randomUUID(),
    sessionId: randomUUID(),
    runId: randomUUID(),
    writerId: randomUUID(),
    piSessionId: randomUUID(),
    fencingToken: 1,
    capabilities: [...ANDROID_CAPABILITIES],
  };
  const tls = await testTls();
  const authority = new ToolCompletionCapabilities(randomUUID());
  completion = completionServer({
    ...tls,
    authority,
    ready: async () => {},
    adapter: new CubeCompletionAdapter({
      images: codec,
      publish: (topic, reply) => publisher.publish(topic, reply),
      progress: { update() {}, forget() {} },
    }),
  });
  await completion.listen({ host: "127.0.0.1", port: 0 });
  const completionPort = completion.server.address().port;
  const destination = (operationId, callId, toolName) => {
    const expiresAt = Date.now() + 90000;
    return {
      url: `https://localhost:${completionPort}/v1/completions`,
      address: "127.0.0.1",
      ca: tls.cert,
      expiresAt,
      capability: authority.issue({
        operationId,
        expiresAt,
        context: {
          kind: "executor_tool",
          scope: { ...binding, turnId: randomUUID() },
          replyTopic: mailbox.topic,
          toolCallId: "task:1",
          nativeToolCallId: callId,
          toolName,
          partition: 0,
        },
      }),
    };
  };
  const operationId = randomUUID();
  const pending = mailbox.wait(
    operationId,
    "observe-1",
    "android_observe",
    AbortSignal.timeout(90000),
  );
  await transport.submit(endpoint, {
    version: 2,
    binding,
    position: { topic: "android-source-fixture", partition: 0, offset: "1", index: 0 },
    operationId,
    nativeCallId: "observe-1",
    toolName: "android_observe",
    arguments: {},
    deadlineAt: Date.now() + 30000,
    completion: destination(operationId, "observe-1", "android_observe"),
  });
  const result = await pending.result;
  assert.equal(result.isError, false);
  assert.equal(result.result.content.filter((c) => c.type === "pi_cloud_image_v1").length, 1);
  report.replyCount++;
  await transport.revoke(endpoint, binding);
  await assert.rejects(
    transport.submit(endpoint, {
      version: 2,
      binding,
      position: { topic: "android-source-fixture", partition: 0, offset: "2", index: 0 },
      operationId: randomUUID(),
      nativeCallId: "old-call",
      toolName: "android_key",
      arguments: { key: "home" },
      deadlineAt: Date.now() + 30000,
      completion: destination(randomUUID(), "old-call", "android_key"),
    }),
    /closed/,
  );
  report.passed = true;
  report.fencing = true;
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  await server?.close();
  await manager?.close();
  await completion?.close();
  await driver.close();
  await transport.close();
  await publisher.close();
  await mailbox.shutdown();
  await kafka.close().catch((error) => {
    report.cleanupError = String(error);
    report.passed = false;
    process.exitCode = 1;
  });
  await writeFile(out, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(report));
}
