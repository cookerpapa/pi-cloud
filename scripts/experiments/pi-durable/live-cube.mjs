// Explicit owned backend fixture. Never restarts shared services or modifies a
// production Run. It uses the deployed fixed Tool guest and boot Kafka replies.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OfficialCubeSandboxRuntimeClient } from "../../../packages/sandbox-control/src/cubesandbox-runtime-client.ts";
import { KafkaToolReplyMailbox } from "../../../packages/event-log/src/index.ts";
import {
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
} from "../../../packages/protocol/src/index.ts";
import { serviceAddress } from "../../lib/production-kubernetes.mjs";
import { testPostgres } from "../../lib/test-postgres.mjs";
import { openJournalBackend, viewEntries, until, deferred } from "./journal.mjs";
import { openHarness, remoteAdapter, ctx, answer, call } from "./harness.mjs";
if (process.env.PI_CLOUD_DURABLE_LIVE_CUBE !== "1")
  throw Error(
    "Set PI_CLOUD_DURABLE_LIVE_CUBE=1 for one disposable Cube allocation and private Kafka topics",
  );
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const base = resolve(repo, "deploy/production/runtime");
const cluster = JSON.parse(await readFile(resolve(base, "cubesandbox/cluster.json"), "utf8"));
const template = JSON.parse(await readFile(resolve(base, "cubesandbox/template.json"), "utf8"));
const key = (await readFile(resolve(base, "secrets/cubesandbox-api-key"), "utf8")).trim();
const brokers =
  process.env.PI_CLOUD_DURABLE_BROKERS?.split(",") ??
  [1, 2, 3].map((i) => `${serviceAddress(`kafka-${i}`)}:9092`);
const client = new OfficialCubeSandboxRuntimeClient({
  apiUrl: `http://${cluster.api.host}:${cluster.api.port}`,
  apiKey: key,
  proxyNodeIp: cluster.proxy.host,
  proxyPort: cluster.proxy.port,
  proxyScheme: "http",
  sandboxDomain: cluster.sandboxDomain,
  egressProxyIp: "10.255.255.254",
  requestTimeoutMs: 90000,
});
const mailbox = new KafkaToolReplyMailbox({ brokers, bootId: randomUUID(), replicas: 3 });
const allocation = { id: randomUUID(), createBefore: Date.now() + 300000 };
const scope = {
  tenantId: randomUUID(),
  sessionId: randomUUID(),
  piSessionId: randomUUID(),
  turnId: randomUUID(),
  runId: randomUUID(),
  writerId: randomUUID(),
};
const activationId = randomUUID();
const environment = {
  environmentVersionId: randomUUID(),
  versionNumber: 1,
  profileKey: "pi-cloud-fullstack",
  profileVersion: "1",
  imageRevision: template.imageRevision,
  specSha256: "e4195cfc4c9e79286d47618d704dbe32dd4141eaa0ce21d82f72699e360f9630",
  recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
};
const initialization = {
  toolWorkerProtocolVersion: 4,
  type: "worker.initialize",
  activationId,
  toolRoot: "/home/user",
  environment,
  workspaceSeed: { kind: "sample_java" },
};
const report = {
  format: "pi-cloud.durable-cube-probe.v1",
  checkedAt: new Date().toISOString(),
  durableVersion: "1.0.0",
  guestProtocol: 3,
  nativeProtocol: 7,
  model: "scripted upstream faux provider",
  accepted: false,
  allocationId: allocation.id,
  checks: [],
  cleanupConfirmed: false,
};
report.replyTopic = mailbox.topic;
let pg,
  backend,
  instance,
  target,
  creationAttempted = false,
  activeHarness;
const source = (position) => ({
  topic: position.topic,
  partition: position.partition,
  offset: position.offset.toString(),
});
const outstanding = new Set();
async function bounded(promise, label, ms = 120000) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(`Timed out: ${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function guest(command) {
  const r = await client.runCommand(instance, {
    command,
    cwd: "/home/user",
    user: "user",
    timeoutMs: 10000,
    maximumOutputBytes: 8192,
  });
  assert.equal(r.exitCode, 0);
  return r.stdout;
}
try {
  await mailbox.start();
  pg = await testPostgres();
  backend = await openJournalBackend({ brokers, databaseUrl: pg.url });
  creationAttempted = true;
  instance = await client.create({
    allocation,
    templateId: template.development.starter.templateId,
    timeoutSeconds: 600,
    metadata: { "picloud.managed": "true", "picloud.workload": "durable-probe" },
    allowInternetAccess: true,
    allowPublicTraffic: false,
    volumeMounts: [],
  });
  target = await client.executionTarget(instance.sandboxId, instance.nodeId);
  report.sandboxId = instance.sandboxId;
  for (const cancel of [false, true]) {
    const marker = `durable-${randomUUID()}`;
    const command = cancel
      ? `printf STARTED > ${marker}; printf PARTIAL; sleep 60; printf LATE > ${marker}.late`
      : `printf ONCE >> ${marker}; printf DURABLE_CUBE_OK`;
    const submitted = deferred();
    let cancelAccepted = false;
    const adapter = remoteAdapter({
      submit: async (c, reply) => {
        const wait = mailbox.wait(c.operationId, c.call.id, "bash", AbortSignal.timeout(90000));
        const receiving = wait.then(
          (event) =>
            reply({ effect: "completed", content: event.result.content, isError: event.isError }),
          (e) => reply({ effect: "unknown", text: e.message, isError: true }),
        );
        outstanding.add(receiving);
        void receiving.finally(() => outstanding.delete(receiving));
        const request = {
          toolBrokerProtocolVersion: 1,
          type: "tool_sandbox.operation",
          activationId,
          operationId: c.operationId,
          turnContextSha256: "a".repeat(64),
          executionContextSha256: "a".repeat(64),
          stepContextSequence: 1,
          stepContextSha256: "a".repeat(64),
          toolName: "bash",
          operation: "tool.execute",
          toolCallId: c.call.id,
          args: { command },
          maximumOutputBytes: 65536,
          timeoutMs: 120000,
        };
        try {
          await client.submitTool(target, {
            source: source(c.position),
            operationId: c.operationId,
            runId: scope.runId,
            writerId: scope.writerId,
            payload: { mode: "operation", initialization, operation: request },
            completionContext: {
              scope,
              replyTopic: mailbox.topic,
              toolCallId: c.call.id,
              nativeToolCallId: c.call.id,
              toolName: "bash",
              partition: 0,
            },
            timeoutMs: 125000,
            maximumOutputBytes: 8 * 1024 * 1024,
          });
          submitted.resolve();
        } catch (error) {
          submitted.reject(error);
          throw error;
        }
      },
      cancel: async (operationId, p) => {
        await client.cancelTool(target, {
          source: source(p),
          runId: scope.runId,
          writerId: scope.writerId,
          operationId,
        });
        cancelAccepted = true;
      },
    });
    const { store, sessionId } = await backend.open(undefined, {
      commands: (b) => adapter.commands(b),
    });
    backend.setDispatcher(sessionId, (c, p) => adapter.dispatch(c, p));
    const { harness, root, faux } = await openHarness(store, {
      execute: adapter.execute,
      hooks: adapter.hooks,
      responses: [
        answer(call("remote", { value: command }), { stopReason: "toolUse" }),
        answer("DONE"),
      ],
    });
    activeHarness = harness;
    const input = await root.submit({ type: "input", content: "Run the fixed remote probe" }, ctx);
    await bounded(submitted.promise, "Cube takeover");
    if (cancel) {
      await until(async () => {
        try {
          return (await guest(`cat ${marker}`)) === "STARTED";
        } catch {
          return false;
        }
      }, "owned command started");
      await root.abort(ctx);
    }
    await bounded(input.wait(ctx), "durable Tool settlement");
    const entries = await viewEntries(harness, root.id);
    const result = entries.find((e) => e.kind === "pi.tool-result");
    assert(result);
    if (!cancel) {
      assert(result.model[0].content.some((p) => p.text?.includes("DURABLE_CUBE_OK")));
      assert.equal(await guest(`cat ${marker}`), "ONCE");
      assert.equal(faux.state.callCount, 2);
    } else {
      assert(cancelAccepted);
      assert.equal(adapter.stats.replies.length, 1);
      assert.equal(await guest(`test ! -e ${marker}.late && printf ABSENT`), "ABSENT");
      assert.equal(faux.state.callCount, 1);
    }
    report.checks.push({
      case: cancel ? "cancel" : "complete",
      accepted: true,
      operationId: adapter.stats.operations[0],
      modelRequests: faux.state.callCount,
      realCubeReplyReceived: adapter.stats.replies.length === 1,
      sourceIsCommittedKafkaPosition: true,
      originalResultPreserved:
        !cancel || result.model[0].content.some((p) => p.text?.includes("PARTIAL")),
    });
    await harness.close(ctx);
    activeHarness = undefined;
    await backend.waitProjected(sessionId, store.commits.at(-1).seq);
  }
  report.accepted = true;
} catch (e) {
  report.failure = e.message;
  process.exitCode = 1;
} finally {
  const errors = [];
  // Close owned VM admission first, even if creation's response was lost.
  if (creationAttempted)
    try {
      const closed = await client.allocation(allocation.id, allocation.createBefore, "close");
      assert(closed.closed && closed.phase === "absent");
      if (instance)
        assert.equal(
          (await client.observe(instance.sandboxId, instance.nodeId)).presence,
          "absent",
        );
      report.physicalAbsenceConfirmed = true;
    } catch (e) {
      errors.push(e.message);
    }
  await mailbox.shutdown().catch((e) => errors.push(e.message));
  await Promise.allSettled([...outstanding]);
  if (activeHarness) await activeHarness.close(ctx).catch((e) => errors.push(e.message));
  for (const close of [() => backend?.close(), () => pg?.close(), () => client.close()])
    try {
      await close();
    } catch (e) {
      errors.push(e.message);
    }
  report.cleanupConfirmed =
    errors.length === 0 && (!creationAttempted || report.physicalAbsenceConfirmed === true);
  if (errors.length) {
    report.cleanupErrors = errors;
    process.exitCode = 1;
  }
  await writeFile(
    process.argv[2] ?? resolve(repo, "docs/reports/pi-durable-cube-verification-20261005.json"),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
}
