// Review characterization only. No provider calls, production data or code fixes.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { DurableAgentSession } from "../../../packages/sandbox-supervisor/src/durable/agent-session.ts";
import { DurableRunEvents } from "../../../packages/sandbox-supervisor/src/durable/run-events.ts";

export async function terminalWithoutPartial() {
  const bodies = [];
  const events = new DurableRunEvents({
    writerId: "review",
    emit: async (body) => {
      bodies.push(body);
    },
    toolId: () => "task:4",
    maximumToolOutputBytes: 1000,
    retryAttempts: 4,
    task: async () => undefined,
  });
  const first = { stepSequence: 11, stepSha256: "a".repeat(64), samplingAttempt: 1 };
  const second = { stepSequence: 22, stepSha256: "b".repeat(64), samplingAttempt: 1 };
  const call = fauxAssistantMessage(fauxToolCall("bash", { command: "true" }), {
    stopReason: "toolUse",
    timestamp: 1,
  });
  await events.samplingStarted(first);
  await events.consume([
    {
      type: "message_end",
      entry: { id: 3, conversationId: 1, kind: "pi.assistant", model: [call] },
    },
  ]);
  const completedBeforeSecond = bodies
    .filter((body) => body.type === "model.sampling.completed")
    .map((body) => body.payload.stepSequence);
  await events.samplingStarted(second);
  const reply = fauxAssistantMessage("done", { timestamp: 2 });
  await events.consume([
    { type: "message_start", message: reply },
    {
      type: "message_end",
      entry: { id: 8, conversationId: 1, kind: "pi.assistant", model: [reply] },
    },
  ]);
  return {
    id: "terminal-without-partial",
    expected: [11, 22],
    completedBeforeSecond,
    actual: bodies
      .filter((body) => body.type === "model.sampling.completed")
      .map((body) => body.payload.stepSequence),
  };
}

export async function compactionRecovery() {
  const journal = [];
  const firstStore = new (class extends MemoryStorage {
    async commit(writes, ctx) {
      const prepared = this.prepareCommit(writes);
      journal.push(structuredClone([...prepared.writes]));
      return prepared.apply();
    }
  })();
  const provider = fauxProvider({ tokensPerSecond: 1_000_000 }),
    models = createModels();
  models.setProvider(provider.provider);
  const model = { ...provider.getModel(), contextWindow: 1024, maxTokens: 128 };
  const runId = randomUUID();
  const settings = {
    retry: { maxRetries: 0 },
    compaction: { enabled: true, reserveTokens: 128, keepRecentTokens: 64 },
  };
  const started = Promise.withResolvers();
  const first = await DurableAgentSession.open(firstStore, { models, remoteTools: [], settings });
  const grant = {
    runId,
    conversationId: 1,
    model,
    agent: {},
    context: {},
    tools: [],
    remoteTools: [],
    assertCurrent: async () => {},
    prepareRemote: async () => {
      throw new Error("No remote effect expected");
    },
  };
  const root = await first.bind({
    ...grant,
    openModel: async (request, native) => {
      assert.equal(native?.purpose, "context_maintenance");
      started.resolve();
      await new Promise((resolve, reject) => {
        const abort = () => reject(new Error("simulated Worker loss"));
        request.options.signal.addEventListener("abort", abort, { once: true });
      });
      throw new Error("unreachable");
    },
  });
  await root.commit(async (tx) => {
    for (let i = 0; i < 5; i++) {
      await tx.appendEntry(root.id, {
        kind: "pi.user",
        model: [{ role: "user", content: "old context ".repeat(400), timestamp: i }],
      });
      await tx.appendEntry(root.id, {
        kind: "pi.assistant",
        model: [fauxAssistantMessage("old answer")],
      });
    }
  }, context);
  await root.submit({ type: "input", content: "continue", requestId: runId }, context);
  await started.promise;
  const prefix = structuredClone(journal);
  await first.close();
  const restored = new MemoryStorage();
  for (const writes of prefix) await restored.commit(writes, context);
  const after = await DurableAgentSession.open(restored, { models, remoteTools: [], settings });
  const requests = [];
  provider.setResponses([fauxAssistantMessage("provider was reached")]);
  try {
    const current = await after.bind({
      ...grant,
      openModel: async (request, native) => {
        requests.push(native?.purpose ?? null);
        // Same guard as the production PiCloudTurnRunner model port.
        if (!native) throw new Error("Model request has no native task context");
        return { model, options: request.options, release() {} };
      },
    });
    after.harness.resume();
    await current.waitForIdle(context);
    const tasks = await restored.scanTasks({ kind: "pi.compaction" }, 20, undefined, context);
    return {
      id: "compaction-recovery",
      requests,
      compactionOutcomes: tasks.items.map((task) => task.state.outcome?.status),
      expectedFirstPurpose: "context_maintenance",
    };
  } finally {
    await after.close();
  }
}

for (const probe of [terminalWithoutPartial, compactionRecovery])
  console.log(JSON.stringify(await probe()));
