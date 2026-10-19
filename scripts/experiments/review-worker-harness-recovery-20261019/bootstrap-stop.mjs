import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createExecutionReference } from "@pi-cloud/protocol";
import { RemoteToolSandboxTurnRunner } from "../../../packages/sandbox-supervisor/src/remote-tool-sandbox-turn-runner.ts";
import { command as sample } from "../../../packages/sandbox-supervisor/test/fixtures/durable-command.ts";
import { scenario } from "./family.mjs";

const output = resolve(
  process.argv[2] ?? "dist/reviews/worker-harness-bootstrap-stop-20261019.json",
);
const report = {
  at: new Date().toISOString(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  scope:
    "Real RemoteToolSandboxTurnRunner + native Harness over captured committed MemoryStorage; controlled ownership/publication/view ports, no PG, Kafka, VM or provider",
};
const f = await scenario("capture"),
  storage = new MemoryStorage();
let seq = 0;
const sequences = new Map();
for (const batch of f.prefix) {
  seq = Number(await storage.commit(batch, context));
  for (const w of batch) sequences.set(w.value?.id ?? w.record?.id ?? w.id, seq);
}
const original = storage.commit.bind(storage);
storage.commit = async (writes, ctx) => {
  const committed = await original(writes, ctx);
  seq = Number(committed);
  for (const w of writes) sequences.set(w.value?.id ?? w.record?.id ?? w.id, seq);
  return committed;
};
const command = structuredClone(sample);
const leaseId = randomUUID();
Object.assign(command.payload, {
  runId: f.runId,
  executionReference: createExecutionReference(leaseId, f.runId, 2),
  stopOnResume: true,
  toolCapabilities: [],
  piSession: { ...command.payload.piSession, writerId: leaseId },
});
// Construct a complete frozen view for the surviving child. The controlled
// loader represents the already-tested PG source/cursor read, not a scheduler.
const source = f.prefix.flatMap((batch, index) =>
  batch
    .filter(
      (w) =>
        w.type === "task" &&
        w.value.kind === "pi.tool" &&
        w.value.conversationId === 1 &&
        w.value.state.checkpoint?.phase === "execute",
    )
    .map((w) => ({ sequence: index + 1, taskId: w.value.id })),
)[0];
assert(source);
const view = {
  id: randomUUID(),
  sessionId: randomUUID(),
  turnId: randomUUID(),
  parentConversationId: 1,
  ownerTaskId: source.taskId,
  contextAnchor: null,
  workingDirectory: "/workspace",
  computeSessionId: null,
  toolCapabilities: [],
  agentSystemPrompt: "",
  source,
};
const directory = await mkdtemp(join(tmpdir(), "pi-review-bootstrap-stop-"));
const stop = new AbortController(),
  authority = new AbortController();
let managed,
  refs = 0,
  activations = 0,
  modelPermits = 0;
const events = [];
const runner = new RemoteToolSandboxTurnRunner({
  trustedWorkspaceDirectory: directory,
  runtimeIdentity: {
    supervisorId: "owned-fixture",
    bootId: randomUUID(),
    sandboxId: "owned-fixture",
  },
  broker: {
    create: async () => {
      activations++;
      throw Error("No VM expected");
    },
    release: async () => ({ retained: false }),
    refreshServices: async () => {},
    workflowUrlFor: () => {
      throw Error("No workflow expected");
    },
  },
  conversations: {
    activeConversations: async () => [
      { conversationId: f.childId, view, prompt: "ask once", nextEventSeq: 1 },
    ],
  },
  openConversationLog: () => ({
    publish: async (event) => {
      events.push(event);
    },
    close: async () => {},
  }),
  openAgentSession: async (c) => {
    refs++;
    return {
      binding: {
        tenantId: c.payload.tenantId,
        sessionId: c.payload.sessionId,
        turnId: c.payload.turnId,
        piSessionId: c.payload.piSession.id,
        runId: f.runId,
        conversationId: c.payload.piSession.conversationId,
        executionReference: c.payload.executionReference,
        writerId: leaseId,
      },
      storage,
      recordSequence: async (id) => sequences.get(id),
      committedSequence: () => seq,
      authority: {
        signal: authority.signal,
        assertCurrent: async () => authority.signal.throwIfAborted(),
        close: async () => {},
      },
      runtime: (factory) => (managed ??= factory()),
      preparePublication: () => {},
      prepareDisplay: () => {},
      serializePublication: (fn) => fn(),
      interrupt: (reason) => authority.abort(reason),
      close: async () => {
        if (--refs === 0) await (await managed)?.close();
      },
    };
  },
  modelRuntimeLeaseResolver: () => ({
    runtime: {
      kind: "openai_compatible_gateway",
      provider: "pi-cloud-fake",
      modelId: "pi-cloud-fake",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:1",
      capability: "owned-fixture",
      reasoning: false,
      inputModalities: ["text"],
      hostedTools: [],
      contextWindow: 131072,
      autoCompactTokenLimit: 100000,
      maxTokens: 1024,
      serviceTier: null,
      requestTimeoutMs: 1000,
      turnTimeoutMs: 5000,
    },
    release: async () => {},
  }),
  acquireModelPermit: async () => {
    modelPermits++;
    throw Error("No model request expected");
  },
  onActivity: (c, value) => {
    if (c.payload.conversationWork && value?.phase === "cancelling")
      queueMicrotask(() =>
        stop.abort({
          kind: "pi-cloud.turn-cancellation",
          reason: "user_request",
          gracePeriodMs: 1000,
        }),
      );
  },
  turnTimeoutMs: 5000,
});
let timer;
const deadline = new Promise((_, reject) => {
  timer = setTimeout(() => {
    authority.abort(new Error("Owned probe deadline"));
    stop.abort({ kind: "pi-cloud.turn-cancellation", reason: "user_request", gracePeriodMs: 0 });
    reject(Error("Owned bootstrap probe deadline"));
  }, 5000);
});
try {
  report.probeSha256 = createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex");
  let outcome;
  try {
    outcome = {
      resolved: true,
      result: await Promise.race([
        runner.run(
          command,
          async (e) => {
            events.push(e);
          },
          stop.signal,
        ),
        deadline,
      ]),
    };
  } catch (e) {
    outcome = { resolved: false, name: e.name, code: e.code, reason: e.reason, message: e.message };
  }
  clearTimeout(timer);
  report.outcome = outcome;
  report.stopDelivered = stop.signal.aborted;
  report.modelPermits = modelPermits;
  report.vmActivations = activations;
  report.childTerminalEvents = events
    .filter(
      (e) => e.payload.event.type === "turn.cancelled" || e.payload.event.type === "turn.failed",
    )
    .map((e) => ({ type: e.payload.event.type, code: e.payload.event.payload.code }));
  assert.equal(modelPermits, 0);
  assert.equal(activations, 0);
  assert.equal(stop.signal.aborted, true);
  assert.equal(outcome.code, "turn_cancelled");
  assert.equal(outcome.reason, "user_request");
  report.completed = true;
} finally {
  clearTimeout(timer);
  authority.abort(Error("Owned fixture closed"));
  try {
    await (await managed)?.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
