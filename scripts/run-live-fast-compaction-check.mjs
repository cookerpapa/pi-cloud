import { fixtureModelRuntime } from "./lib/test-model-catalog.mjs";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { ModelMeteringService } from "@pi-cloud/accounting";
import { S3AttachmentBlobStore } from "../packages/session-attachments/src/s3.ts";
import { purgeOwnedAcceptanceTenant } from "./lib/owned-acceptance-cleanup.mjs";
// Real Luna + the production Models facade and native Durable compaction.
// The small fixture window is component acceptance, not a capacity benchmark.
import assert from "node:assert/strict";
import { zstdDecompressSync } from "node:zlib";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { modelSamplingHeaders, MODEL_PURPOSE_HEADER } from "@pi-cloud/protocol";
import { TenantModelGateway } from "../packages/supervisor-host/src/model-gateway.ts";
import { DurableAgentSession } from "../packages/sandbox-supervisor/src/durable/agent-session.ts";
import { CloudModelRegistry } from "../packages/sandbox-supervisor/src/durable/model-registry.ts";
import { mergeProviderServiceTier } from "../packages/sandbox-supervisor/src/provider-hosted-tools.ts";
import { serviceAddress, runtimeDirectory } from "./lib/production-kubernetes.mjs";

if (process.env.PI_CLOUD_LIVE_FAST_COMPACTION_CHECK !== "1")
  throw new Error("Set PI_CLOUD_LIVE_FAST_COMPACTION_CHECK=1 for real Luna usage");
const report = {
  checkedAt: new Date().toISOString(),
  model: "gpt-6-luna",
  accepted: false,
  scope:
    "Real Gateway/Durable/Luna with a 4096-token fixture window; no PG/Kafka Run or production catalog mutation",
  requests: [],
  compactions: [],
};
const databaseUrl = new URL(
  (await readFile(`${runtimeDirectory}/secrets/database-url`, "utf8")).trim(),
);
databaseUrl.hostname = serviceAddress("postgres");
const database = createDatabase({ connectionString: databaseUrl.toString(), maxConnections: 2 });
let tenant;
let purpose = "agent",
  sequence = 0,
  lease,
  runtime,
  events;
const gateway = new TenantModelGateway({
  host: "127.0.0.1",
  port: 0,
  advertisedBaseUrl: "http://127.0.0.1",
  providerGatewayBaseUrl: `http://${serviceAddress("cli-proxy-api")}:8317`,
  providerGatewayApiKey: (
    await readFile("deploy/production/runtime/secrets/cli-proxy-api-key", "utf8")
  ).trim(),
  maximumRequestsPerTurn: 6,
  fetchImplementation: async (url, init) => {
    const encoded = Buffer.from(init.body);
    const body = JSON.parse(
      (new Headers(init.headers).get("content-encoding") === "zstd"
        ? zstdDecompressSync(encoded)
        : encoded
      ).toString("utf8"),
    );
    report.requests.push({ purpose, serviceTier: body.service_tier, model: body.model });
    return fetch(url, init);
  },
});
try {
  await gateway.start();
  tenant = await createPrivateTenant(database, {
    slug: `release-acceptance-compact-${randomUUID()}`,
    ownerDisplayName: "Model compaction acceptance",
    initialModel: { provider: "openai-codex", modelId: report.model },
  });
  const runId = randomUUID(),
    sessionId = randomUUID();
  lease = gateway.issue({
    payload: {
      tenantId: tenant.tenantId,
      sessionId,
      piSession: { id: sessionId, conversationId: 1, writerId: randomUUID() },
      turnId: randomUUID(),
      runId,
      model: {
        provider: "openai-codex",
        modelId: report.model,
        profileId: randomUUID(),
        runtime: fixtureModelRuntime("openai-codex", report.model),
        thinkingLevel: "low",
        credentialBindingId: randomUUID(),
        credentialBindingVersion: 1,
        serviceTier: "fast",
      },
    },
  });
  const registry = new CloudModelRegistry();
  const model = registry.configure({
    provider: "openai-codex",
    modelId: report.model,
    api: "openai-codex-responses",
    apiKey: lease.runtime.capability,
    baseUrl: `http://127.0.0.1:${gateway.listeningPort}`,
    contextWindow: 4096,
    maxTokens: 4096,
    reasoning: true,
  });
  const storage = new MemoryStorage();
  runtime = await DurableAgentSession.open(storage, {
    models: registry.models,
    remoteTools: [],
    settings: {
      compaction: { enabled: true, reserveTokens: 2048, keepRecentTokens: 128 },
      retry: { maxRetries: 0 },
    },
  });
  const conversation = await runtime.bind({
    runId,
    conversationId: 1,
    model,
    context: {},
    agent: {
      thinkingLevel: "low",
      instructions: "Retain the project invariant marker. Answer briefly.",
    },
    remoteTools: [],
    tools: [],
    assertCurrent: async () => {},
    prepareRemote: async () => {
      throw new Error("No Tools in this fixture");
    },
    openModel: async (request, native) => {
      purpose = native?.purpose ?? "agent";
      report.grants = (report.grants ?? 0) + 1;
      return {
        model,
        options: {
          ...request.options,
          apiKey: lease.runtime.capability,
          transport: "sse",
          timeoutMs: 150000,
          headers: {
            [MODEL_PURPOSE_HEADER]: native?.purpose ?? "agent",
            ...modelSamplingHeaders({
              stepSequence: ++sequence,
              stepSha256: createHash("sha256").update(String(sequence)).digest("hex"),
              samplingAttempt: 1,
            }),
          },
          onPayload: (value) => mergeProviderServiceTier(value, "fast"),
        },
        release() {},
      };
    },
  });
  const marker = "FAST-COMPACTION-POLICY-OK";
  for (let i = 0; i < 4; i++) {
    await conversation.commit(async (tx) => {
      await tx.appendEntry(conversation.id, {
        kind: "pi.user",
        model: [
          {
            role: "user",
            content:
              `Project invariant marker: ${marker}. Preserve it in summaries. ` +
              "We are checking request policy and preserving project history. ".repeat(80),
            timestamp: Date.now(),
          },
        ],
      });
      await tx.appendEntry(conversation.id, {
        kind: "pi.assistant",
        model: [
          {
            role: "assistant",
            content: [{ type: "text", text: `Recorded ${marker}.` }],
            api: model.api,
            provider: model.provider,
            model: model.id,
            stopReason: "stop",
            timestamp: Date.now(),
            usage: {
              input: 5000,
              output: 20,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 5020,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          },
        ],
      });
    }, BACKGROUND_CONTEXT);
  }
  events = await runtime.watch(1, async (changes) => {
    for (const event of changes)
      if (event.type === "compaction_end") {
        const task = await storage.task(event.taskId, BACKGROUND_CONTEXT);
        report.compactions.push({
          status: task.state.outcome?.status,
          error: task.state.outcome?.error?.message?.replaceAll(
            lease.runtime.capability,
            "[redacted]",
          ),
        });
      }
  });
  const submitted = await conversation.submit(
    {
      type: "input",
      content: "Return only the project invariant marker recorded earlier.",
      requestId: runId,
    },
    BACKGROUND_CONTEXT,
  );
  const settled = await submitted.wait(BACKGROUND_CONTEXT);
  assert.equal(settled.status, "done");
  await conversation.waitForIdle(BACKGROUND_CONTEXT);
  const entries = (await conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items;
  assert(
    entries.some((entry) => entry.head !== undefined),
    "No committed native compaction head",
  );
  assert(report.requests.some((request) => request.purpose === "context_maintenance"));
  assert(report.requests.some((request) => request.purpose === "agent"));
  assert(
    report.requests.every((request) => request.serviceTier === "fast"),
    "Frozen Fast tier changed",
  );
  assert(
    entries
      .flatMap((entry) => entry.model ?? [])
      .find((message) => message.role === "assistant")
      ?.content.some((part) => part.type === "text" && part.text.includes(marker)),
    "Compaction lost the marker",
  );
  const metering = new ModelMeteringService(database);
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const page = await metering.list(tenant.tenantId, {
      from: new Date(Date.now() - 3600000).toISOString(),
      to: new Date().toISOString(),
      limit: 50,
    });
    report.modelMetering = page.items.map((item) => ({
      purpose: item.context.purpose,
      state: item.state,
      executions: item.usage.length,
    }));
    if (
      page.items.some(
        (item) => item.context.purpose === "context_maintenance" && item.usage.length,
      ) &&
      page.items.some((item) => item.context.purpose === "agent" && item.usage.length)
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert(
    report.modelMetering?.some((item) => item.purpose === "context_maintenance" && item.executions),
  );
  report.accepted = true;
} catch (error) {
  report.failure = error.message;
  throw error;
} finally {
  await events?.close?.(BACKGROUND_CONTEXT);
  await runtime?.close();
  await lease?.release();
  await gateway.close();
  if (tenant) {
    const blobs = new S3AttachmentBlobStore({
      endpoint: `http://${serviceAddress("session-images")}:8333`,
      region: "us-east-1",
      bucket: "pi-cloud-session-images",
      ...JSON.parse(
        await readFile(`${runtimeDirectory}/secrets/session-image-s3-credentials.json`, "utf8"),
      ),
    });
    try {
      await purgeOwnedAcceptanceTenant(database, tenant, blobs);
      report.cleanupConfirmed = true;
    } finally {
      blobs.close();
    }
  }
  await database.destroy();
  await writeFile(
    process.argv[2] ?? "docs/reports/durable-fast-compaction-20261006.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
}
