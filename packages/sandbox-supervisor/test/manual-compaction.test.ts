import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  MemoryStorage,
  CompactionTask,
  GenerationTask,
  LiveDoc,
  type StorageWrite,
  type TaskId,
  type CompactionResult,
} from "@earendil-works/pi-durable";
import {
  BACKGROUND_CONTEXT as context,
  awaitWithContext,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import {
  DurableAgentSession,
  type DurableRunConfiguration,
  type NativeRequestContext,
} from "../src/durable/agent-session.ts";
import {
  admitManualCompaction,
  CompactRequestDocument,
  manualCompactionState,
} from "../src/durable/manual-compaction.ts";

async function fixture() {
  const writes: StorageWrite[][] = [];
  const storage = new (class extends MemoryStorage {
    override async commit(batch: readonly StorageWrite[]) {
      writes.push(structuredClone([...batch]));
      return super.commit(batch, context);
    }
  })();
  const provider = fauxProvider({ tokensPerSecond: 1_000_000 }),
    models = createModels();
  models.setProvider(provider.provider);
  const model = { ...provider.getModel(), contextWindow: 1_000_000, maxTokens: 1024 };
  const settings = {
    retry: { maxRetries: 0 },
    compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 64 },
  };
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
      throw new Error("No tool expected");
    },
  };
  const request = {
    requestId: randomUUID(),
    fingerprint: "a".repeat(64),
    runId: run.runId,
    requestedAt: new Date().toISOString(),
  };
  const seed = async (root: Awaited<ReturnType<DurableAgentSession["bind"]>>) => {
    await root.commit(async (tx) => {
      for (let i = 0; i < 4; i++) {
        await tx.appendEntry(root.id, {
          kind: "pi.user",
          model: [{ role: "user", content: "retained work ".repeat(500), timestamp: i }],
        });
        await tx.appendEntry(root.id, {
          kind: "pi.assistant",
          model: [fauxAssistantMessage("old answer")],
        });
      }
    }, context);
  };
  return { writes, storage, provider, models, model, settings, run, request, seed };
}

it("admits the native compaction task, live status and idempotent receipt in one commit", async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>(),
    gate = Promise.withResolvers<void>();
  const runtime = await DurableAgentSession.open(f.storage, {
    models: f.models,
    remoteTools: [],
    settings: f.settings,
  });
  try {
    const root = await runtime.bind({
      ...f.run,
      openModel: async (request) => {
        entered.resolve();
        await awaitWithContext(gate.promise, withAbortSignal(request.options.signal!, context));
        return { model: f.model, options: request.options, release() {} };
      },
    });
    await f.seed(root);
    const receipt = await admitManualCompaction(runtime.harness, runtime.storage, root, f.request);
    await entered.promise;
    const batch = f.writes.find((b) =>
      b.some(
        (w) =>
          w.type === "document.create" && w.record.kind === CompactRequestDocument.definition.kind,
      ),
    )!;
    expect(
      batch.some(
        (w) =>
          w.type === "task" && w.value.id === receipt.taskId && w.value.kind === "pi.compaction",
      ),
    ).toBe(true);
    expect((await runtime.harness.snapshot(LiveDoc, root.id, context))?.compactions).toMatchObject([
      { taskId: receipt.taskId, reason: "manual", blocking: false },
    ]);
    expect(await admitManualCompaction(runtime.harness, runtime.storage, root, f.request)).toEqual({
      ...receipt,
      replayed: true,
    });
    await expect(
      admitManualCompaction(runtime.harness, runtime.storage, root, {
        ...f.request,
        fingerprint: "b".repeat(64),
      }),
    ).rejects.toThrow("identity");
    await expect(
      admitManualCompaction(runtime.harness, runtime.storage, root, {
        ...f.request,
        requestId: randomUUID(),
      }),
    ).rejects.toThrow("already in progress");
    expect(
      (await f.storage.scanTasks({ kind: "pi.compaction" }, 100, undefined, context)).items,
    ).toHaveLength(1);
  } finally {
    await runtime.close();
  }
});

it.each([false, true])(
  "keeps concurrent task identities and native placement, recovered=%s",
  async (recover) => {
    const f = await fixture();
    const originalGeneration = GenerationTask.definition.phases.request;
    const originalCompaction = CompactionTask.definition.phases.summarize;
    let runtime = await DurableAgentSession.open(f.storage, {
      models: f.models,
      remoteTools: [],
      settings: f.settings,
    });
    let seen: NativeRequestContext[] = [];
    let generation = Promise.withResolvers<void>(),
      summary = Promise.withResolvers<void>();
    let enteredGeneration = Promise.withResolvers<void>(),
      enteredSummary = Promise.withResolvers<void>();
    const bind = () =>
      runtime.bind({
        ...f.run,
        openModel: async (request, native) => {
          expect(native).toBeDefined();
          seen.push({ ...native! });
          const isSummary = native!.purpose === "context_maintenance";
          (isSummary ? enteredSummary : enteredGeneration).resolve();
          await awaitWithContext(
            (isSummary ? summary : generation).promise,
            withAbortSignal(request.options.signal!, context),
          );
          return { model: f.model, options: request.options, release() {} };
        },
      });
    try {
      let root = await bind();
      await f.seed(root);
      const submission = await root.submit(
        { type: "input", content: "continue", requestId: f.run.runId },
        context,
      );
      await enteredGeneration.promise;
      const receipt = await admitManualCompaction(
        runtime.harness,
        runtime.storage,
        root,
        f.request,
      );
      await enteredSummary.promise;
      expect(seen.map((x) => x.purpose)).toEqual(["agent", "context_maintenance"]);
      const generationId = seen[0]!.taskId;
      expect(generationId).not.toBe(receipt.taskId);
      expect(seen[1]!.taskId).toBe(receipt.taskId);
      if (recover) {
        const prefix = structuredClone(f.writes);
        await runtime.close();
        const restored = new MemoryStorage();
        for (const batch of prefix) await restored.commit(batch, context);
        runtime = await DurableAgentSession.open(restored, {
          models: f.models,
          remoteTools: [],
          settings: f.settings,
        });
        seen = [];
        generation = Promise.withResolvers();
        summary = Promise.withResolvers();
        enteredGeneration = Promise.withResolvers();
        enteredSummary = Promise.withResolvers();
        root = await bind();
        runtime.harness.resume();
        await Promise.all([enteredGeneration.promise, enteredSummary.promise]);
        expect(seen.find((x) => x.purpose === "agent")?.taskId).toBe(generationId);
        expect(seen.find((x) => x.purpose === "context_maintenance")?.taskId).toBe(receipt.taskId);
        expect(
          await admitManualCompaction(runtime.harness, runtime.storage, root, f.request),
        ).toEqual({ ...receipt, replayed: true });
      }
      f.provider.setResponses([
        fauxAssistantMessage("retained summary"),
        fauxAssistantMessage("continued answer"),
      ]);
      summary.resolve();
      await runtime.harness.waitForTask(receipt.taskId as TaskId<CompactionResult>, context);
      expect((await manualCompactionState(runtime.harness, 1, f.request.requestId))?.state).toBe(
        "awaiting_placement",
      );
      generation.resolve();
      await root.waitForIdle(context);
      expect((await manualCompactionState(runtime.harness, 1, f.request.requestId))?.state).toBe(
        "applied",
      );
      expect((await runtime.harness.submission(submission.id, context))?.id).toBe(submission.id);
      expect((await root.context(context)).entries.some((e) => e.kind === "pi.compaction")).toBe(
        true,
      );
      expect(GenerationTask.definition.phases.request).toBe(originalGeneration);
      expect(CompactionTask.definition.phases.summarize).toBe(originalCompaction);
    } finally {
      await runtime.close();
    }
  },
);

it("uses the same native admission as Conversation.compact", async () => {
  const admitted: unknown[] = [],
    statuses: unknown[] = [];
  for (const explicit of [false, true]) {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const runtime = await DurableAgentSession.open(f.storage, {
      models: f.models,
      remoteTools: [],
      settings: f.settings,
    });
    try {
      const root = await runtime.bind({
        ...f.run,
        openModel: async (request) => {
          entered.resolve();
          await awaitWithContext(
            new Promise<never>(() => {}),
            withAbortSignal(request.options.signal!, context),
          );
          throw new Error("unreachable");
        },
      });
      await f.seed(root);
      const id = explicit
        ? (await admitManualCompaction(runtime.harness, runtime.storage, root, f.request)).taskId
        : await root.compact(undefined, context);
      await entered.promise;
      const created = f.writes.flat().find((w) => w.type === "task" && w.value.id === id);
      expect(created?.type).toBe("task");
      if (created?.type !== "task") throw new Error("Missing native task");
      admitted.push({ ...created.value, id: 0 });
      statuses.push(
        (await runtime.harness.snapshot(LiveDoc, root.id, context))?.compactions?.map((s) => ({
          ...s,
          taskId: 0,
        })),
      );
    } finally {
      await runtime.close();
    }
  }
  expect(admitted[1]).toEqual(admitted[0]);
  expect(statuses[1]).toEqual(statuses[0]);
});

it.each(["stop", "failure", "stale", "no_op"] as const)(
  "manual compact settles %s without damaging prior context",
  async (mode) => {
    const f = await fixture(),
      entered = Promise.withResolvers<void>(),
      gate = Promise.withResolvers<void>();
    const runtime = await DurableAgentSession.open(f.storage, {
      models: f.models,
      remoteTools: [],
      settings: f.settings,
    });
    try {
      const root = await runtime.bind({
        ...f.run,
        openModel: async (request) => {
          entered.resolve();
          await awaitWithContext(gate.promise, withAbortSignal(request.options.signal!, context));
          return { model: f.model, options: request.options, release() {} };
        },
      });
      if (mode !== "no_op") await f.seed(root);
      const before = (await root.context(context)).entries.map((e) => e.id);
      await admitManualCompaction(runtime.harness, runtime.storage, root, f.request);
      if (mode !== "no_op") await entered.promise;
      if (mode === "stop") await root.abort(context);
      else {
        if (mode === "stale") await root.reset("new focus", context);
        f.provider.setResponses([
          fauxAssistantMessage(
            mode === "failure" ? "" : "summary",
            mode === "failure" ? { stopReason: "error", errorMessage: "fixture failure" } : {},
          ),
        ]);
        gate.resolve();
        await root.waitForIdle(context);
      }
      expect((await manualCompactionState(runtime.harness, 1, f.request.requestId))?.state).toBe(
        mode === "stop" ? "cancelled" : mode === "failure" ? "failed" : mode,
      );
      if (mode === "stop" || mode === "failure")
        expect((await root.context(context)).entries.map((e) => e.id)).toEqual(before);
      if (mode === "no_op") expect(f.provider.state.callCount).toBe(0);
      if (mode === "stale")
        expect(
          (await root.context(context)).messages.some(
            (m) => m.role === "user" && m.content === "new focus",
          ),
        ).toBe(true);
    } finally {
      await runtime.close();
    }
  },
);
