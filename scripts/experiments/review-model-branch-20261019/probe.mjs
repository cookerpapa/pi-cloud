// Owned loopback HTTP + pinned Pi model adapters. No real providers, credentials,
// production storage or VM effects. Assertions characterize the reviewed source.
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { TenantModelGateway } from "../../../packages/supervisor-host/src/model-gateway.ts";
import { CloudModelRegistry } from "../../../packages/sandbox-supervisor/src/durable/model-registry.ts";
import { ScopedDurableModels } from "../../../packages/sandbox-supervisor/src/durable/scoped-models.ts";
import { DurableTextPresentation } from "../../../packages/sandbox-supervisor/src/durable/text-presentation.ts";
import { applyProviderHostedTranscript } from "../../../packages/sandbox-supervisor/src/provider-hosted-transcript.ts";
import { command as seed } from "../../../packages/sandbox-supervisor/test/fixtures/durable-command.ts";
import { modelSamplingHeaders, createPiCloudEventFactory } from "@pi-cloud/protocol";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import { Harness, MemoryStorage, configure, createRegistry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

const output = process.argv[2] ?? "/tmp/pi-cloud-model-branch-review.json";
const encoder = new TextEncoder();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (check) => {
  const deadline = Date.now() + 5000;
  while (!check()) {
    assert(Date.now() < deadline, "Fixture did not reach its requested boundary");
    await pause(5);
  }
};
const report = {
  at: new Date().toISOString(),
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  scriptSha256: createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex"),
  scope:
    "Loopback Model Gateway + pinned Pi 1.0 public Models adapters; synthetic upstream streams",
  cases: [],
};
const messageItem = (id, phase, text = "") => ({
  type: "message",
  id,
  role: "assistant",
  status: "completed",
  phase,
  content: text ? [{ type: "output_text", text, annotations: [] }] : [],
});
const reasoning = {
  type: "reasoning",
  id: "reasoning-1",
  summary: [{ type: "summary_text", text: "Planning" }],
};
const search = {
  type: "web_search_call",
  id: "search-1",
  status: "completed",
  action: { type: "search", query: "synthetic fixture" },
};
const start = { type: "response.created", response: { id: "response-1", status: "in_progress" } };
const add = (item, index) => ({ type: "response.output_item.added", output_index: index, item });
const delta = (index, text) => ({
  type: "response.output_text.delta",
  output_index: index,
  content_index: 0,
  delta: text,
});
const done = (item, index) => ({ type: "response.output_item.done", output_index: index, item });
const terminal = (items) => ({
  type: "response.completed",
  response: {
    id: "response-1",
    status: "completed",
    output: items,
    usage: {
      input_tokens: 5,
      output_tokens: 4,
      total_tokens: 9,
      input_tokens_details: { cached_tokens: 0 },
    },
  },
});

async function fixture(provider = "openai-codex", mode = "stream", startRequest = true) {
  const modelId = provider === "deepseek" ? "deepseek-v4-flash" : "gpt-6-luna";
  const metrics = [],
    transcripts = [],
    activities = [],
    events = [],
    providerEvents = [];
  let upstreamController,
    sends = 0,
    releaseCount = 0,
    cancelled = false;
  const gateway = new TenantModelGateway({
    host: "127.0.0.1",
    port: 0,
    advertisedBaseUrl: "http://127.0.0.1",
    providerGatewayBaseUrl: "http://unused.invalid",
    providerGatewayApiKey: "fixture-key-".padEnd(48, "x"),
    upstreamConnectTimeoutMs: 500,
    upstreamIdleTimeoutMs: 1000,
    metrics: { modelDuration: { observe: (labels) => metrics.push(labels) } },
    fetchImplementation: async (_input, init) => {
      sends++;
      if (mode === "header-reset" || (mode === "recover-after-reset" && sends === 1))
        throw new TypeError("fetch failed: synthetic connection reset");
      if (mode === "recover-after-reset") {
        const text = messageItem("recovered", "final_answer", "Recovered");
        return new Response(
          [
            start,
            add(messageItem("recovered", "final_answer"), 0),
            delta(0, "Recovered"),
            done(text, 0),
            terminal([text]),
          ]
            .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
            .join(""),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return new Response(
        new ReadableStream({
          start(controller) {
            upstreamController = controller;
            init.signal.addEventListener(
              "abort",
              () => {
                if (!cancelled) {
                  cancelled = true;
                  try {
                    controller.error(new Error("synthetic upstream aborted"));
                  } catch {}
                }
              },
              { once: true },
            );
          },
          cancel() {
            cancelled = true;
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  await gateway.start();
  const cmd = structuredClone(seed);
  cmd.payload.tenantId = "10000000-0000-4000-8000-000000000001";
  cmd.payload.sessionId = "10000000-0000-4000-8000-000000000002";
  cmd.payload.piSession.id = cmd.payload.sessionId;
  cmd.payload.model.provider = provider;
  cmd.payload.model.modelId = modelId;
  const lease = gateway.issue(cmd);
  lease.subscribeHostedActivity((activity) => activities.push(activity));
  lease.subscribeHostedTranscript((transcript) => transcripts.push(transcript));
  const registry = new CloudModelRegistry();
  const model = registry.configure({
    ...lease.runtime,
    baseUrl: `http://127.0.0.1:${gateway.listeningPort}${provider === "deepseek" ? "/v1" : ""}`,
  });
  const signal = new AbortController();
  const router = new ScopedDurableModels(registry.models, async ({ options }) => ({
    model,
    options: {
      ...options,
      apiKey: lease.runtime.capability,
      transport: "sse",
      timeoutMs: 1500,
      headers: modelSamplingHeaders({
        stepSequence: 1,
        stepSha256: "a".repeat(64),
        samplingAttempt: 1,
      }),
      onProviderStreamEvent: (event) =>
        providerEvents.push({
          type: event.type,
          ...(event.item?.type ? { itemType: event.item.type } : {}),
        }),
    },
    decorate(message) {
      const transcript = transcripts.at(-1);
      if (transcript) applyProviderHostedTranscript(message, transcript);
    },
    release() {
      releaseCount++;
    },
  }));
  const route = router.register(cmd.payload.runId, 1, model);
  const stream = startRequest
    ? router.models.streamSimple(
        router.models.getModel(route.provider, route.modelId),
        { messages: [{ role: "user", content: "synthetic fixture", timestamp: 1 }] },
        { signal: signal.signal },
      )
    : undefined;
  const drain = (async () => {
    if (stream) for await (const event of stream) events.push(structuredClone(event));
  })();
  if (startRequest && mode !== "header-reset") await waitFor(() => upstreamController);
  return {
    gateway,
    lease,
    metrics,
    events,
    transcripts,
    activities,
    providerEvents,
    models: router.models,
    modelReference: route,
    send(...frames) {
      for (const frame of frames)
        upstreamController.enqueue(encoder.encode(`data: ${JSON.stringify(frame)}\n\n`));
    },
    fail() {
      upstreamController.error(new Error("synthetic connection lost"));
    },
    end() {
      upstreamController.close();
    },
    abort() {
      signal.abort();
    },
    async result() {
      await drain;
      return stream.result();
    },
    counts() {
      return { sends, releaseCount, cancelled };
    },
    async close() {
      signal.abort();
      await lease.release();
      await gateway.close();
      await drain;
    },
  };
}

// Exercise native Durable's actual retry decision, not only its classifier.
for (const provider of ["openai-codex", "deepseek"]) {
  const f = await fixture(provider, "recover-after-reset", false);
  const harness = await Harness.open(
    new MemoryStorage(),
    {
      models: f.models,
      registry: createRegistry(),
      settings: { compaction: { enabled: false }, retry: { maxRetries: 1, baseDelayMs: 1 } },
    },
    BACKGROUND_CONTEXT,
  );
  try {
    const root = await harness.root(BACKGROUND_CONTEXT);
    await root.commit(
      (tx) => configure(tx, root.id, { model: f.modelReference }),
      BACKGROUND_CONTEXT,
    );
    const input = await root.submit(
      { type: "input", content: "synthetic native retry" },
      BACKGROUND_CONTEXT,
    );
    const outcome = await input.wait(BACKGROUND_CONTEXT);
    const entries = await root.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    const assistants = entries.items
      .toSorted((a, b) => a.id - b.id)
      .flatMap((e) => e.model ?? [])
      .filter((m) => m.role === "assistant");
    assert.equal(f.counts().sends, provider === "openai-codex" ? 1 : 2);
    assert.equal(assistants.at(-1).stopReason, provider === "openai-codex" ? "error" : "stop");
    report.cases.push({
      name: "native-harness-retry-after-header-reset",
      provider,
      upstreamSends: f.counts().sends,
      nativeSubmissionStatus: outcome.status,
      assistantStopReasons: assistants.map((m) => m.stopReason),
    });
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await f.close();
  }
}

function presentation(f, partial) {
  const state = { run: { taskId: 3, inputs: [] }, generation: { attempt: 1, message: partial } };
  const record = {
    id: 2,
    kind: "pi.live",
    version: 1,
    createdAt: 1,
    scope: { kind: "conversation", conversationId: 1 },
    history: "latest",
  };
  const display = new DurableTextPresentation({
    conversationId: 1,
    phase: f.lease.resolveAssistantTextPhase,
  });
  return display
    .prepare(
      { seq: 1, nextId: 20, writes: [{ type: "document.change", id: 2 }] },
      [{ record, after: { record, version: 1, value: state, deltasSinceBase: 0 } }],
      createPiCloudEventFactory({ sessionId: "fixture", turnId: "fixture", agentId: "root" }),
    )
    .events.map((e) => ({
      contentIndex: e.source.path?.at(-2),
      phase: e.event.payload.phase ?? null,
    }));
}

// Ordinary progressing reasoning + commentary: native content index and observer
// message ordinal differ before output_item.done supplies the final signature.
{
  const f = await fixture();
  try {
    f.send(
      start,
      add(reasoning, 0),
      add(messageItem("comment", "commentary"), 1),
      delta(1, "Checking"),
    );
    await waitFor(() => f.events.some((e) => e.type === "text_delta"));
    const partial = f.events.findLast((e) => e.type === "text_delta").partial;
    const phases = presentation(f, partial);
    assert.deepEqual(
      partial.content.map((b) => b.type),
      ["thinking", "text"],
    );
    assert.equal(f.lease.resolveAssistantTextPhase("response-1", 0), "commentary");
    assert.equal(phases.find((e) => e.contentIndex === 1).phase, null);
    f.send(
      done(reasoning, 0),
      done(messageItem("comment", "commentary", "Checking"), 1),
      terminal([reasoning, messageItem("comment", "commentary", "Checking")]),
    );
    f.end();
    const final = await f.result();
    assert.equal(final.stopReason, "stop");
    report.cases.push({
      name: "early-phase-after-reasoning",
      sourcePhase: "commentary",
      partialContentIndex: 1,
      observedPhaseOrdinal: 0,
      presentedPhase: phases[0].phase,
      finalSignatureHasPhase: final.content[1].textSignature.includes("commentary"),
    });
  } finally {
    await f.close();
  }
}

// Both provider adapters receive the same public gateway failure protocol.
for (const provider of ["openai-codex", "deepseek"])
  for (const mode of ["header-reset", "stream-reset"]) {
    const f = await fixture(provider, mode);
    try {
      if (mode === "stream-reset") {
        f.send(start, add(messageItem("text-1", "final_answer"), 0), delta(0, "Partial retained"));
        await waitFor(() => f.events.some((e) => e.type === "text_delta"));
        f.fail();
      }
      const final = await f.result();
      assert.equal(final.stopReason, "error");
      assert.equal(f.counts().sends, 1);
      report.cases.push({
        name: mode,
        provider,
        stopReason: final.stopReason,
        errorMessage: final.errorMessage,
        nativeRetryable: isRetryableAssistantError(final),
        retainedCharacters: final.content
          .filter((b) => b.type === "text")
          .reduce((n, b) => n + b.text.length, 0),
        modelPermitReleases: f.counts().releaseCount,
        upstreamSends: f.counts().sends,
        publicProviderHookFrames: f.providerEvents.length,
      });
    } finally {
      await f.close();
    }
  }

// A completed hosted operation is distinct from an incomplete local Tool call.
for (const outcome of ["success", "network-error", "user-stop"]) {
  const f = await fixture();
  try {
    f.send(
      start,
      add(search, 0),
      done(search, 0),
      add(messageItem("text-1", "final_answer"), 1),
      delta(1, "Searched"),
    );
    await waitFor(() => f.events.some((e) => e.type === "text_delta"));
    if (outcome === "success") {
      f.send(
        done(messageItem("text-1", "final_answer", "Searched"), 1),
        terminal([search, messageItem("text-1", "final_answer", "Searched")]),
      );
      f.end();
    } else if (outcome === "network-error") f.fail();
    else f.abort();
    const final = await f.result();
    const hosted = final.content.filter((b) => b.type === "providerHostedToolCall").length;
    assert.equal(hosted, outcome === "success" ? 1 : 0);
    assert(f.activities.some((a) => a.phase === "completed" && a.outcome === "completed"));
    assert(
      f.providerEvents.some(
        (e) => e.type === "response.output_item.done" && e.itemType === "web_search_call",
      ),
    );
    report.cases.push({
      name: "completed-hosted-search",
      outcome,
      stopReason: final.stopReason,
      observedSearchCompleted: true,
      publicHookSawCompletedSearch: true,
      finalHostedItems: hosted,
      transcriptCallbacks: f.transcripts.length,
    });
  } finally {
    await f.close();
  }
}

// Codex stops at its terminal event; leaving the HTTP tail open is not a failed
// model response, though the gateway currently reports downstream disconnection.
{
  const f = await fixture();
  try {
    const text = messageItem("final", "final_answer", "Done");
    f.send(
      start,
      add(messageItem("final", "final_answer"), 0),
      delta(0, "Done"),
      done(text, 0),
      terminal([text]),
    );
    const final = await f.result();
    assert.equal(final.stopReason, "stop");
    await waitFor(() => f.metrics.length > 0);
    assert.equal(f.metrics[0].outcome, "failed");
    report.cases.push({
      name: "successful-terminal-before-http-eof",
      nativeStopReason: final.stopReason,
      gatewayMetric: f.metrics[0].outcome,
      upstreamCancelled: f.counts().cancelled,
    });
  } finally {
    await f.close();
  }
}

// Two text items make the ordinal mismatch assign the other item's phase.
{
  const f = await fixture();
  try {
    f.send(
      start,
      add(reasoning, 0),
      add(messageItem("comment", "commentary"), 1),
      delta(1, "Checking"),
      add(messageItem("final", "final_answer"), 2),
      delta(2, "Done"),
    );
    await waitFor(() => f.events.filter((e) => e.type === "text_delta").length === 2);
    const phases = presentation(f, f.events.findLast((e) => e.type === "text_delta").partial);
    assert.deepEqual(
      phases.map((p) => p.phase),
      ["final_answer", null],
    );
    const items = [
      reasoning,
      messageItem("comment", "commentary", "Checking"),
      messageItem("final", "final_answer", "Done"),
    ];
    f.send(...items.map(done), terminal(items));
    f.end();
    assert.equal((await f.result()).stopReason, "stop");
    report.cases.push({
      name: "two-text-phases-after-reasoning",
      expected: ["commentary", "final_answer"],
      actual: phases.map((p) => p.phase),
    });
  } finally {
    await f.close();
  }
}
report.completed = true;
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(report, null, 2) + "\n");
console.log(JSON.stringify({ completed: true, cases: report.cases }));
