// Real Luna + the production Gateway/CloudAgentRuntime/Pi compactor, using a
// small fixture window. This is component acceptance, not a PG/Kafka Run or a
// million-token capacity test. No production model configuration is changed.
import assert from "node:assert/strict";
import { zstdDecompressSync } from "node:zlib";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { modelSamplingHeaders } from "@pi-cloud/protocol";
import { TenantModelGateway } from "../packages/supervisor-host/src/model-gateway.ts";
import { CloudAgentRuntime } from "../packages/sandbox-supervisor/src/cloud-agent-runtime.ts";
import { mergeProviderServiceTier } from "../packages/sandbox-supervisor/src/provider-hosted-tools.ts";
import { serviceAddress } from "./lib/production-kubernetes.mjs";

if (process.env.PI_CLOUD_LIVE_FAST_COMPACTION_CHECK !== "1")
  throw new Error("Set PI_CLOUD_LIVE_FAST_COMPACTION_CHECK=1 for real Luna usage");
const directory = await mkdtemp(join(tmpdir(), "pi-cloud-live-compaction-"));
const report = {
  checkedAt: new Date().toISOString(),
  model: "gpt-6-luna",
  accepted: false,
  scope:
    "Real Gateway/Pi/Luna component acceptance with a 4096-token fixture window; no PG/Kafka execution or production catalog mutation",
  requests: [],
  compactions: [],
};
let purpose = "sampling",
  sequence = 0,
  lease,
  models;
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
  lease = gateway.issue({
    payload: {
      tenantId: randomUUID(),
      sessionId: randomUUID(),
      turnId: randomUUID(),
      runId: randomUUID(),
      model: {
        provider: "openai-codex",
        modelId: report.model,
        profileId: randomUUID(),
        serviceTier: "fast",
      },
    },
  });
  models = await ModelRuntime.create({
    modelsPath: null,
    authPath: join(directory, "auth.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  models.registerProvider("openai-codex", {
    name: "fixture",
    baseUrl: `http://127.0.0.1:${gateway.listeningPort}`,
    apiKey: lease.runtime.capability,
    api: "openai-codex-responses",
    models: [
      {
        id: report.model,
        name: report.model,
        reasoning: true,
        input: ["text"],
        contextWindow: 4096,
        maxTokens: 4096,
        thinkingLevelMap: { minimal: "low", low: "low", medium: "medium", high: "high" },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
  await models.setRuntimeApiKey("openai-codex", lease.runtime.capability);
  const model = models.getModel("openai-codex", report.model);
  assert(model);
  const session = await new InMemorySessionRepo().create();
  const marker = "FAST-COMPACTION-POLICY-OK";
  for (let i = 0; i < 4; i++) {
    await session.appendMessage({
      role: "user",
      content:
        `Project invariant marker: ${marker}. Preserve it in summaries. ` +
        "We are checking model request policy and preserving this project's conversation. ".repeat(
          50,
        ),
      timestamp: Date.now(),
    });
    await session.appendMessage({
      role: "assistant",
      content: [{ type: "text", text: `Recorded project marker ${marker}.` }],
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
    });
  }
  const runtime = new CloudAgentRuntime({
    session,
    lane: "main",
    model,
    models,
    thinkingLevel: "low",
    systemPrompt: "Retain the project invariant marker. Answer briefly.",
    authority: {
      signal: new AbortController().signal,
      assertCurrent: async () => {},
      close: async () => {},
    },
    commonModelOptions: {
      transport: "sse",
      timeoutMs: 150000,
      onPayload: (value) => mergeProviderServiceTier(value, "fast"),
    },
    retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
    compaction: { enabled: true, reserveTokens: 2048, keepRecentTokens: 128 },
    transformHeaders: (headers) => ({
      ...headers,
      ...modelSamplingHeaders({
        stepSequence: ++sequence,
        stepSha256: createHash("sha256").update(String(sequence)).digest("hex"),
        samplingAttempt: 1,
      }),
    }),
    onEvent: (event) => {
      if (event.type === "compaction_start") purpose = "compaction";
      if (event.type === "sampling_start") purpose = "sampling";
      if (event.type === "compaction_end") {
        purpose = "sampling";
        report.compactions.push({ success: event.success, aborted: event.aborted });
      }
    },
  });
  const result = await runtime.run("Return only the project invariant marker recorded earlier.");
  assert.equal(result.kind, "completed", result.error?.message);
  assert(
    report.compactions.some((c) => c.success && !c.aborted),
    "No successful native compaction",
  );
  assert(
    report.requests.some((r) => r.purpose === "compaction"),
    "No real summary request",
  );
  assert(
    report.requests.some((r) => r.purpose === "sampling"),
    "No post-compaction sampling",
  );
  assert(
    report.requests.every((r) => r.serviceTier === "fast"),
    "Frozen Fast tier changed",
  );
  assert(
    result.finalMessage.content.some((p) => p.type === "text" && p.text.includes(marker)),
    "Summary lost the marker",
  );
  report.accepted = true;
} catch (error) {
  report.failure = error.message;
  throw error;
} finally {
  await lease?.release();
  await gateway.close();
  await models?.removeRuntimeApiKey("openai-codex");
  await rm(directory, { recursive: true, force: true });
  await writeFile(
    process.argv[2] ?? "docs/reports/fast-compaction-acceptance-20261005.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
}
