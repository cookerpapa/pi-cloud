import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  BACKGROUND_CONTEXT as context,
  awaitWithContext,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import { DurableAgentSession } from "../../../packages/sandbox-supervisor/src/durable/agent-session.ts";

const output = resolve(process.argv[2] ?? "dist/reviews/worker-harness-family-20261019.json");
const report = {
  at: new Date().toISOString(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  scope:
    "Real pinned Harness reopened from a captured committed prefix; in-memory Storage and faux models, no process crash or provider",
  cases: [],
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export async function scenario(mode) {
  const journal = [];
  const storage = new (class extends MemoryStorage {
    async commit(writes) {
      const prepared = this.prepareCommit(writes);
      journal.push(structuredClone(prepared.writes));
      return prepared.apply();
    }
  })();
  const parentModel = fauxProvider({ provider: "review-parent", tokensPerSecond: 1000000 });
  const childModel = fauxProvider({ provider: "review-child", tokensPerSecond: 1000000 });
  const models = createModels();
  models.setProvider(parentModel.provider);
  models.setProvider(childModel.provider);
  parentModel.setResponses([
    fauxAssistantMessage(fauxToolCall("delegate", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("PARENT ALREADY ANSWERED"),
  ]);
  childModel.setResponses([
    fauxAssistantMessage(fauxToolCall("ask", {}), { stopReason: "toolUse" }),
  ]);
  const runId = randomUUID(),
    asked = Promise.withResolvers();
  let old,
    child,
    childId,
    asks = 0,
    delegations = 0;
  let current = true;
  const gate = Promise.withResolvers();
  const config = (id, provider, tools, restored = false) => ({
    runId,
    conversationId: id,
    model: provider.getModel(),
    agent: {},
    context: id === 1 ? {} : { view: { id: "owned-child-view", sessionId: randomUUID() } },
    tools,
    remoteTools: [],
    assertCurrent: async () => {
      if (!current) throw Error("not the current test owner");
    },
    prepareRemote: async () => {
      throw Error("No remote tool expected");
    },
    ...(restored
      ? {
          beforeEffect: (signal) =>
            awaitWithContext(gate.promise, withAbortSignal(signal, context)),
        }
      : {}),
    openModel: async (request) => ({
      model: provider.getModel(),
      options: request.options,
      release() {},
    }),
  });
  const ask = {
    name: "ask",
    description: "Hold a native child task",
    parameters: Type.Object({}),
    execute: async (_args, _api, ctx) => {
      asks++;
      asked.resolve();
      await awaitWithContext(new Promise(() => {}), ctx);
      throw Error("unreachable");
    },
  };
  const delegate = {
    name: "delegate",
    description: "Create one native child",
    parameters: Type.Object({}),
    execute: async (_args, api) => {
      delegations++;
      childId = await old.createConversation({
        requestId: "child-create",
        ownerTaskId: api.taskId,
        parentConversationId: 1,
      });
      child = await old.bind(config(childId, childModel, [ask]));
      await child.submit({ type: "input", content: "ask once", requestId: "child-input" }, context);
      await asked.promise;
      return { content: [{ type: "text", text: "child remains active" }] };
    },
  };
  const options = {
    models,
    remoteTools: [],
    infrastructureTools: [ask, delegate],
    settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
  };
  old = await DurableAgentSession.open(storage, options);
  let prefix;
  try {
    const root = await old.bind(config(1, parentModel, [delegate]));
    const accepted = await root.submit(
      { type: "input", content: "delegate", requestId: runId },
      context,
    );
    await asked.promise;
    assert.equal((await accepted.wait(context)).status, "done");
    await child.submit(
      {
        type: "input",
        content: "LATEST FOLLOW-UP",
        requestId: "queued-child",
        whenBusy: "followUp",
      },
      context,
    );
    const inspection = await old.harness.inspect(context);
    assert(
      inspection.tasks.some(
        ({ record: r }) => r.conversationId === 1 && r.state.status === "completing",
      ),
    );
    assert.equal(
      (await storage.submissionByRequest(childId, "queued-child", context)).status,
      "queued",
    );
    prefix = structuredClone(journal);
  } finally {
    await old.close();
  }
  if (mode === "capture") return { prefix, runId, childId };
  const restored = new MemoryStorage();
  for (const writes of prefix) await restored.commit(writes, context);
  childModel.setResponses([
    fauxAssistantMessage("CHILD RECOVERED"),
    fauxAssistantMessage("FOLLOW-UP RECOVERED"),
  ]);
  const before = childModel.state.callCount;
  const next = await DurableAgentSession.open(restored, options);
  try {
    const views = await next.activeConversationViews(runId);
    assert.equal(views.length, 1);
    assert.equal(views[0].conversationId, childId);
    next.harness.resume();
    await pause(30);
    assert.equal(childModel.state.callCount, before);
    const root = await next.bind(config(1, parentModel, [delegate], true));
    current = false;
    await assert.rejects(next.bind(config(childId, childModel, [ask], true)), /not the current/);
    current = true;
    await next.bind(config(childId, childModel, [ask], true));
    let idle = false;
    const waiting = root.waitForIdle(context).then(() => {
      idle = true;
    });
    await pause(30);
    assert.equal(idle, false);
    assert.equal(childModel.state.callCount, before);
    if (mode === "stop") await root.abort(context);
    else gate.resolve();
    await waiting;
    const original = await restored.submissionByRequest(childId, "child-input", context),
      queued = await restored.submissionByRequest(childId, "queued-child", context);
    assert.equal(original.status, mode === "stop" ? "unanswered" : "done");
    assert.equal(queued.status, mode === "stop" ? "unanswered" : "done");
    assert.equal(asks, 1);
    assert.equal(delegations, 1);
    const queueReceipts = (
      await restored.scanSubmissions({ conversationId: childId }, 100, undefined, context)
    ).items.filter((s) => s.requestId === "queued-child");
    assert.equal(queueReceipts.length, 1);
    report.cases.push({
      mode,
      restoredActiveChild: true,
      rootFinalDidNotEndFamily: true,
      grantRequired: true,
      bindingBarrierHeld: true,
      delegations,
      originalAskExecutions: asks,
      queuedReceiptCount: queueReceipts.length,
      queuedStatus: queued.status,
      newChildModelCalls: childModel.state.callCount - before,
    });
    assert.equal(childModel.state.callCount - before, mode === "stop" ? 0 : 2);
  } finally {
    gate.resolve();
    await next.close();
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  try {
    report.probeSha256 = createHash("sha256")
      .update(await readFile(new URL(import.meta.url)))
      .digest("hex");
    for (const mode of ["continue", "stop"]) await scenario(mode);
    report.completed = true;
  } finally {
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
  }
