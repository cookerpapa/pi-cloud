/**
 * Focused review evidence, not a regression suite accepting incorrect behavior.
 * Run: node --import tsx scripts/review-cloud-agent-runtime.mjs
 * Exit 0 means all probes ran and their native controls held; findingsObserved
 * reports differences. All model streams/auth are synthetic. No provider,
 * database, Kafka, Cube, user extension or production service is contacted.
 * Designed for the repository's pinned Pi 0.84.1 API.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("..", import.meta.url));
const nativeSessions = new Set();
function packageJsonUrl(name) {
  return new URL("../package.json", import.meta.resolve("@earendil-works/" + name));
}
// Pinned provider-normalization oracle only; no private Pi import in production.
const { transformMessages } = await import(
  new URL("./dist/api/transform-messages.js", packageJsonUrl("pi-ai")).href
);
const fixtureRoot = await mkdtemp(join(tmpdir(), "pi-cloud-runtime-review-"));
import {
  Agent,
  InMemorySessionRepo,
  buildSessionContext,
  estimateContextTokens,
  estimateTokens,
} from "@earendil-works/pi-agent-core";
import { EventStream } from "@earendil-works/pi-ai";
import {
  AgentSession,
  SessionManager,
  SettingsManager,
  DefaultResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { CloudAgentRuntime } from "../packages/sandbox-supervisor/src/cloud-agent-runtime.ts";

const model = {
  id: "gpt-6-luna",
  name: "Scripted GPT-6 Luna fixture",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "http://127.0.0.1:1",
  reasoning: false,
  input: ["text"],
  contextWindow: 10000,
  maxTokens: 1000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function assistant(text = "done", stopReason = "stop", extra = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...extra,
  };
}
function stream(message) {
  const out = new EventStream(
    (e) => e.type === "done" || e.type === "error",
    (e) => (e.type === "done" ? e.message : e.error),
  );
  queueMicrotask(() =>
    out.push(
      message.stopReason === "error" || message.stopReason === "aborted"
        ? { type: "error", reason: message.stopReason, error: message }
        : { type: "done", reason: message.stopReason, message },
    ),
  );
  return out;
}
function authority() {
  const controller = new AbortController();
  return {
    signal: controller.signal,
    assertCurrent: async () => controller.signal.throwIfAborted(),
    close: async () => {},
    controller,
  };
}
async function cloud(extra = {}) {
  const session = await new InMemorySessionRepo().create();
  const contexts = [];
  const options = {
    session,
    lane: "main",
    systemPrompt: "review",
    model,
    authority: authority(),
    compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
    streamFn: (_model, context) => {
      contexts.push(structuredClone(context));
      return stream(assistant());
    },
    ...extra,
  };
  return { runtime: new CloudAgentRuntime(options), session: options.session, contexts, options };
}
function native(streamFn, settings = {}) {
  const settingsManager = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    ...settings,
  });
  const agent = new Agent({ streamFn, initialState: { model, systemPrompt: "review", tools: [] } });
  const resourceLoader = new DefaultResourceLoader({
    cwd: fixtureRoot,
    agentDir: fixtureRoot,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: "review",
  });
  const modelRuntime = {
    getAuth: async () => ({ auth: { apiKey: "synthetic-no-network" }, env: {} }),
    hasConfiguredAuth: () => true,
    isUsingOAuth: () => false,
    getRegisteredProviderIds: () => [],
  };
  const sessionManager = SessionManager.inMemory(fixtureRoot);
  const session = new AgentSession({
    agent,
    sessionManager,
    settingsManager,
    resourceLoader,
    modelRuntime,
    cwd: fixtureRoot,
    baseToolsOverride: {},
    initialActiveToolNames: [],
  });
  nativeSessions.add(session);
  return { agent, session, sessionManager };
}
async function lateInput() {
  const rows = [];
  for (const delivery of ["steer", "follow_up", "human_steer"]) {
    let runtime;
    let sent = false;
    let accepted = false;
    const f = await cloud({
      onEvent: async (e) => {
        if (e.type === "agent_end" && !sent) {
          sent = true;
          try {
            if (delivery === "human_steer") await runtime.steer("LATE-MARKER");
            else await runtime.agentInput("late-id", "LATE-MARKER", delivery);
            accepted = true;
          } catch {
            accepted = false;
          }
        }
      },
    });
    runtime = f.runtime;
    const result = await runtime.run("initial");
    rows.push({
      delivery,
      accepted,
      result: result.kind,
      requests: f.contexts.length,
      consumed: JSON.stringify(await f.session.findEntries()).includes("LATE-MARKER"),
    });
  }
  const contexts = [];
  let sent = false;
  const f = native((_m, c) => {
    contexts.push(structuredClone(c));
    return stream(assistant());
  });
  f.agent.subscribe(async (e) => {
    if (e.type === "agent_end" && !sent) {
      sent = true;
      await f.session.steer("LATE-MARKER");
    }
  });
  await f.session.prompt("initial");
  return {
    cloud: rows,
    native: {
      requests: contexts.length,
      consumed: JSON.stringify(contexts.at(-1)).includes("LATE-MARKER"),
    },
  };
}
async function cancelBackoff() {
  const rows = [];
  for (const kind of ["cloud", "native"]) {
    let calls = 0;
    const sf = () => {
      calls++;
      return stream(assistant("", "error", { errorMessage: "network error" }));
    };
    let cancelAt = 0;
    let promise;
    const retryEnds = [];
    const retry = { enabled: true, maxRetries: 2, baseDelayMs: 500 };
    if (kind === "cloud") {
      let runtime;
      const f = await cloud({
        streamFn: sf,
        retry,
        onEvent: (e) => {
          if (e.type === "auto_retry_end")
            retryEnds.push({ success: e.success, attempt: e.attempt });
          if (e.type === "auto_retry_start")
            setTimeout(() => {
              cancelAt = performance.now();
              runtime.abort();
            }, 10);
        },
      });
      runtime = f.runtime;
      promise = runtime.run("initial");
    } else {
      const f = native(sf, { retry });
      f.session.subscribe((e) => {
        if (e.type === "auto_retry_end") retryEnds.push({ success: e.success, attempt: e.attempt });
        if (e.type === "auto_retry_start")
          setTimeout(() => {
            cancelAt = performance.now();
            void f.session.abort();
          }, 10);
      });
      promise = f.session.prompt("initial");
    }
    const result = await promise;
    rows.push({
      kind,
      calls,
      settledAfterCancelMs: Math.round(performance.now() - cancelAt),
      outcome: result?.kind ?? "settled",
      retryEnds,
    });
  }
  return rows;
}
async function lateInputDuringFinish() {
  const session = await new InMemorySessionRepo().create();
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const delayedSession = new Proxy(session, {
    get(target, key) {
      if (key === "appendRecord")
        return async (record) => {
          if (record.type === "operation_finished") {
            entered.resolve();
            await release.promise;
          }
          return target.appendRecord(record);
        };
      const v = Reflect.get(target, key, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const f = await cloud({ session: delayedSession });
  const running = f.runtime.run("initial");
  await entered.promise;
  let accepted = false;
  try {
    await f.runtime.steer("FINISH-MARKER");
    accepted = true;
  } catch {
    accepted = false;
  } finally {
    release.resolve();
  }
  const outcome = await running;
  return {
    accepted,
    outcome: outcome.kind,
    requests: f.contexts.length,
    consumed: JSON.stringify(await session.findEntries()).includes("FINISH-MARKER"),
  };
}
async function staleCompaction() {
  const session = await new InMemorySessionRepo().create();
  const old = assistant("tiny previous answer");
  old.usage.input = 9500;
  old.usage.totalTokens = 9501;
  old.timestamp = Date.now() - 10000;
  const tail = [
    { role: "user", content: "tiny previous request", timestamp: old.timestamp - 1 },
    old,
  ];
  await session.appendEntry(
    {
      id: "prior-compaction",
      type: "compaction",
      summary: "short summary",
      retainedTail: tail,
      tokensBefore: 9500,
    },
    "main",
  );
  const messages = buildSessionContext(await session.findEntries()).messages;
  let summaries = 0;
  const f = await cloud({
    session,
    compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 },
    models: {
      completeSimple: async () => {
        summaries++;
        return assistant("new summary");
      },
    },
  });
  const result = await f.runtime.run("continue");
  const nativeContexts = [];
  const n = native(
    (_m, c) => {
      nativeContexts.push(structuredClone(c));
      return stream(assistant());
    },
    { compaction: { enabled: true, reserveTokens: 1000, keepRecentTokens: 100 } },
  );
  const kept = n.sessionManager.appendMessage(tail[0]);
  n.sessionManager.appendMessage(old);
  n.sessionManager.appendCompaction("short summary", kept, 9500);
  n.agent.state.messages = n.sessionManager.buildSessionContext().messages;
  await n.session.prompt("continue");

  return {
    estimatedFromOldUsage: estimateContextTokens(messages).tokens,
    structuralTokens: messages.reduce((n, m) => n + estimateTokens(m), 0),
    cloud: { extraSummaries: summaries, requests: f.contexts.length, result: result.kind },
    native: {
      requests: nativeContexts.length,
      extraSummaries:
        n.sessionManager.getBranch().filter((e) => e.type === "compaction").length - 1,
    },
  };
}
async function interruptedToolPair() {
  const session = await new InMemorySessionRepo().create();
  const op = "old-operation";
  const initial = {
    id: "initial",
    type: "message",
    message: { role: "user", content: "old task", timestamp: Date.now() },
  };
  await session.appendRecord({
    id: op,
    lane: "main",
    type: "operation_started",
    sourceLeafId: null,
    intent: { kind: "run", originalPrompt: [initial.message], initialMessages: [initial] },
  });
  await session.appendEntry(initial, "main");
  const answer = assistant("", "toolUse", {
    content: [
      { type: "toolCall", id: "one", name: "effect", arguments: {} },
      { type: "toolCall", id: "two", name: "effect", arguments: {} },
    ],
  });
  await session.appendEntry({ id: "old-answer", type: "message", message: answer }, "main");
  await session.appendRecord({
    id: "intent-one",
    lane: "main",
    type: "tool_started",
    runId: op,
    assistantEntryId: "old-answer",
    toolIndex: 0,
    toolCallId: "one",
    toolName: "effect",
    effectiveArgs: {},
    resultEntryId: "result-one",
    replay: "never",
  });
  const f = await cloud({ session });
  await f.runtime.run("next task");
  const normalized = transformMessages(f.contexts[0].messages, model);
  const results = normalized
    .filter((m) => m.role === "toolResult")
    .map((m) => ({
      id: m.toolCallId,
      text: m.content
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join(""),
      isError: m.isError,
    }));
  assert.equal(results.length, 2);
  assert.match(results.find((r) => r.id === "one").text, /side effects are unknown/);
  assert.equal(results.find((r) => r.id === "two").text, "No result provided");
  const starts = await session.findRecords({ type: "tool_started" });
  assert.equal(starts.length, 1);
  return {
    providerResults: results,
    newToolIntents: starts.length - 1,
    durableResults: (await session.findEntries())
      .filter((e) => e.type === "message" && e.message.role === "toolResult")
      .map((e) => e.message.toolCallId),
  };
}
async function retryBudgetAcrossFollowup() {
  const results = [];
  for (const kind of ["cloud", "native"]) {
    const responses = [
      assistant("", "error", { errorMessage: "network error" }),
      assistant("", "error", { errorMessage: "network error" }),
      assistant("first success"),
      assistant("", "error", { errorMessage: "network error" }),
      assistant("second success"),
    ];
    let requests = 0,
      queued = false;
    const sf = () => {
      requests++;
      return stream(responses.shift() ?? assistant("unexpected"));
    };
    const retry = { enabled: true, maxRetries: 2, baseDelayMs: 1 };
    if (kind === "cloud") {
      const f = await cloud({
        streamFn: sf,
        retry,
        prepareFollowUp: () => {
          if (queued) return;
          queued = true;
          return { role: "user", content: "followup", timestamp: Date.now() };
        },
      });
      const result = await f.runtime.run("initial");
      results.push({ kind, requests, outcome: result.kind, final: result.finalMessage.stopReason });
    } else {
      const f = native(sf, { retry });
      f.agent.subscribe(async (e) => {
        if (e.type === "turn_end" && e.message.stopReason === "stop" && !queued) {
          queued = true;
          await f.session.followUp("followup");
        }
      });
      await f.session.prompt("initial");
      results.push({ kind, requests, final: f.agent.state.messages.at(-1)?.stopReason });
    }
  }
  return results;
}

const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  scope: "CloudAgentRuntime versus Pi AgentSession, synthetic streams and in-memory native storage",
  realProviderCalls: 0,
  piVersions: {},
  sourceSha256: {},
  probes: {},
  findingsObserved: [],
};
const keepAlive = setInterval(() => {}, 1000);
const deadline = setTimeout(() => {
  process.stderr.write("Runtime review probe exceeded 30 seconds\n");
  process.exit(1);
}, 30000);
try {
  for (const name of ["pi-agent-core", "pi-ai", "pi-coding-agent"]) {
    const pkg = JSON.parse(await readFile(packageJsonUrl(name), "utf8"));
    report.piVersions[name] = pkg.version;
    assert.equal(
      pkg.version,
      "0.84.1",
      "Revalidate the audit fixture before changing its Pi baseline",
    );
  }
  const sources = {
    CloudAgentRuntime: join(root, "packages/sandbox-supervisor/src/cloud-agent-runtime.ts"),
    PiCloudTurnRunner: join(root, "packages/sandbox-supervisor/src/pi-cloud-turn-runner.ts"),
    "Pi.Agent": fileURLToPath(new URL("./dist/agent.js", packageJsonUrl("pi-agent-core"))),
    "Pi.AgentSession": fileURLToPath(
      new URL("./dist/core/agent-session.js", packageJsonUrl("pi-coding-agent")),
    ),
  };
  for (const [name, path] of Object.entries(sources))
    report.sourceSha256[name] = createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  for (const [name, probe] of Object.entries({
    lateInput,
    lateInputDuringFinish,
    retryBudgetAcrossFollowup,
    staleCompaction,
    cancelBackoff,
    interruptedToolPair,
  })) {
    report.probes[name] = await probe();
  }
  const p = report.probes;
  assert.equal(p.lateInput.native.requests, 2);
  assert.equal(p.lateInput.native.consumed, true);
  assert.equal(p.retryBudgetAcrossFollowup.find((r) => r.kind === "native").requests, 5);
  assert.equal(p.retryBudgetAcrossFollowup.find((r) => r.kind === "native").final, "stop");
  assert.equal(p.staleCompaction.native.extraSummaries, 0);
  assert.equal(p.staleCompaction.native.requests, 1);
  assert.ok(p.staleCompaction.structuralTokens < 100);
  for (const row of p.cancelBackoff)
    assert.equal(row.calls, 1, "Cancellation must not make a second provider call");
  assert.deepEqual(p.cancelBackoff.find((r) => r.kind === "native").retryEnds, [
    { success: false, attempt: 1 },
  ]);
  const cancelled = p.cancelBackoff.find((r) => r.kind === "cloud");
  if (
    p.lateInput.cloud.some((r) => r.accepted && !r.consumed) ||
    (p.lateInputDuringFinish.accepted && !p.lateInputDuringFinish.consumed)
  )
    report.findingsObserved.push("CR-01");
  if (p.retryBudgetAcrossFollowup.find((r) => r.kind === "cloud").final !== "stop")
    report.findingsObserved.push("CR-02");
  if (p.staleCompaction.cloud.extraSummaries > p.staleCompaction.native.extraSummaries)
    report.findingsObserved.push("CR-03");
  if (cancelled.retryEnds.some((r) => r.success) || cancelled.settledAfterCancelMs > 250)
    report.findingsObserved.push("CR-04");
  report.probesCompleted = Object.keys(report.probes).length;
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} finally {
  clearInterval(keepAlive);
  clearTimeout(deadline);
  for (const session of nativeSessions) session.dispose();
  await rm(fixtureRoot, { recursive: true, force: true });
}
