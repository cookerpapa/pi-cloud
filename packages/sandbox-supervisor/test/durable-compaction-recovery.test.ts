import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { MemoryStorage, type StorageWrite, type TaskId } from "@earendil-works/pi-durable";
import {
  BACKGROUND_CONTEXT as context,
  awaitWithContext,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { DurableAgentSession, type DurableRunConfiguration } from "../src/durable/agent-session.ts";

async function interruptedCompaction() {
  const journal: StorageWrite[][] = [];
  const storage = new (class extends MemoryStorage {
    override async commit(writes: readonly StorageWrite[]) {
      const prepared = this.prepareCommit(writes);
      journal.push(structuredClone([...prepared.writes]));
      return prepared.apply();
    }
  })();
  const provider = fauxProvider({ tokensPerSecond: 1_000_000 }),
    models = createModels();
  models.setProvider(provider.provider);
  const model = { ...provider.getModel(), contextWindow: 1024, maxTokens: 128 };
  const settings = {
    retry: { maxRetries: 0 },
    compaction: { enabled: true, reserveTokens: 128, keepRecentTokens: 64 },
  };
  const entered = Promise.withResolvers<void>();
  const run: Omit<DurableRunConfiguration, "openModel"> = {
    runId: randomUUID(),
    conversationId: 1,
    model,
    agent: {},
    context: {},
    tools: [],
    remoteTools: () => [],
    assertCurrent: async () => {},
    prepareRemote: async () => {
      throw new Error("No Tool expected");
    },
  };
  const owner = await DurableAgentSession.open(storage, { models, remoteTools: [], settings });
  try {
    const root = await owner.bind({
      ...run,
      openModel: async (request, native) => {
        expect(native?.purpose).toBe("context_maintenance");
        entered.resolve();
        await awaitWithContext(
          new Promise<never>(() => {}),
          withAbortSignal(request.options.signal!, context),
        );
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
    await root.submit({ type: "input", content: "continue", requestId: run.runId }, context);
    await entered.promise;
    const prefix = structuredClone(journal);
    return { prefix, run, models, provider, model, settings };
  } finally {
    await owner.close();
  }
}

it.each(["summarize", "retry", "stop"] as const)(
  "recovers native Compaction at %s under the new Run grant",
  async (mode) => {
    const f = await interruptedCompaction(),
      storage = new MemoryStorage();
    for (const writes of f.prefix) await storage.commit(writes, context);
    const task = (await storage.scanTasks({ kind: "pi.compaction" }, 1, undefined, context))
      .items[0]!;
    if (mode === "retry") {
      if (!("checkpoint" in task.state)) throw new Error("Expected a native checkpoint");
      // Persist the native retry shape; reopening must not require its select hook.
      await storage.commit(
        [
          {
            type: "task",
            value: {
              ...task,
              state: {
                status: "running",
                checkpoint: { ...(task.state.checkpoint as object), phase: "retry", until: 0 },
              },
            },
          },
        ],
        context,
      );
    }
    const runtime = await DurableAgentSession.open(storage, {
      models: f.models,
      remoteTools: [],
      settings: f.settings,
    });
    const requests: { taskId: number; purpose: string; attempt: number }[] = [];
    const held = Promise.withResolvers<void>();
    f.provider.setResponses([
      fauxAssistantMessage("retained summary"),
      fauxAssistantMessage("continued"),
    ]);
    let currentGrant = false;
    try {
      const configure = {
        ...f.run,
        assertCurrent: async () => {
          if (!currentGrant) throw new Error("grant revoked");
        },
        ...(mode === "stop"
          ? {
              beforeEffect: async (signal?: AbortSignal) => {
                held.resolve();
                await awaitWithContext(
                  new Promise<never>(() => {}),
                  withAbortSignal(signal!, context),
                );
              },
            }
          : {}),
        openModel: async (
          request: Parameters<DurableRunConfiguration["openModel"]>[0],
          native: Parameters<DurableRunConfiguration["openModel"]>[1],
        ) => {
          if (!native) throw new Error("Model request has no native task context");
          const task = await runtime.harness.getTask(native.taskId as TaskId, context);
          if (!task || !("checkpoint" in task.state)) throw new Error("Missing checkpoint");
          requests.push({
            taskId: native.taskId,
            purpose: native.purpose,
            attempt: (task.state.checkpoint as { attempt: number }).attempt,
          });
          return { model: f.model, options: request.options, release() {} };
        },
      };
      await expect(runtime.bind(configure)).rejects.toThrow("grant revoked");
      expect(f.provider.state.callCount).toBe(0);
      currentGrant = true;
      const root = await runtime.bind(configure);
      runtime.harness.resume();
      if (mode === "stop") {
        await held.promise;
        await root.abort(context);
        expect(requests).toEqual([]);
        expect(f.provider.state.callCount).toBe(0);
      } else {
        await root.waitForIdle(context);
        expect(requests[0]).toEqual({
          taskId: task.id,
          purpose: "context_maintenance",
          attempt: mode === "retry" ? 2 : 1,
        });
        expect(requests[1]?.purpose).toBe("agent");
      }
      const compacted = await storage.task(task.id, context);
      expect(compacted?.state).toMatchObject({
        status: "terminal",
        outcome: { status: mode === "stop" ? "aborted" : "completed" },
      });
    } finally {
      await runtime.close();
    }
  },
);
