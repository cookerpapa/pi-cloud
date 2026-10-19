import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  AgentDoc,
  MemoryStorage,
  type StorageWrite,
  type Seq,
  type Submission,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import {
  BACKGROUND_CONTEXT as context,
  awaitWithContext,
  withAbortSignal,
} from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import { DurableAgentSession, type DurableRunConfiguration } from "../src/durable/agent-session.ts";

it("carries owner cancellation through public Harness bootstrap reads", async () => {
  const storage = new MemoryStorage(),
    entered = Promise.withResolvers<Context>();
  const scan = vi
    .spyOn(storage, "scanTasks")
    .mockImplementation(async (_query, _limit, _cursor, ctx) => {
      entered.resolve(ctx);
      await awaitWithContext(new Promise<void>(() => {}), ctx);
      throw Error("unreachable");
    });
  const abort = new AbortController();
  const opening = DurableAgentSession.open(
    storage,
    { models: createModels(), remoteTools: [] },
    withAbortSignal(abort.signal, context),
  );
  const rejected = expect(opening).rejects.toBeInstanceOf(Error);
  try {
    const observed = await entered.promise;
    abort.abort(new Error("Owned startup retired"));
    await rejected;
    expect(observed.abortSignal?.aborted).toBe(true);
  } finally {
    abort.abort();
    await rejected;
    scan.mockRestore();
  }
});

it.each(["continue", "stop"] as const)(
  "reattaches existing native child configuration and queued input (%s)",
  async (mode) => {
    const models = createModels();
    const parentProvider = fauxProvider({
      provider: "parent-recovery",
      tokensPerSecond: 1_000_000,
    });
    const childProvider = fauxProvider({ provider: "child-recovery", tokensPerSecond: 1_000_000 });
    models.setProvider(parentProvider.provider);
    models.setProvider(childProvider.provider);
    parentProvider.setResponses([
      fauxAssistantMessage(fauxToolCall("delegate", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("ROOT HAS ANSWERED"),
    ]);
    childProvider.setResponses([
      fauxAssistantMessage("CHILD ANSWER"),
      fauxAssistantMessage("FOLLOWUP ANSWER"),
    ]);
    const runId = randomUUID(),
      sessionId = randomUUID(),
      turnId = randomUUID();
    const journal: StorageWrite[][] = [];
    const storage = new (class extends MemoryStorage {
      override async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
        const prepared = this.prepareCommit(writes);
        journal.push(structuredClone([...prepared.writes]));
        return prepared.apply();
      }
    })();
    let runtime!: DurableAgentSession, childConfig!: DurableRunConfiguration;
    let original!: Submission, queued!: Submission;
    let delegations = 0,
      recoveredCalls = 0;
    const held = Promise.withResolvers<void>();
    const config = (
      id: number,
      child: boolean,
      tools: ToolRegistration[],
    ): DurableRunConfiguration => ({
      runId,
      conversationId: id,
      model: child ? childProvider.getModel() : parentProvider.getModel(),
      agent: {
        instructions: child ? "KEEP THE STORED CHILD INSTRUCTIONS" : "Root instructions",
        cwd: "/workspace",
      },
      context: child ? { sessionId, turnId, view: { id: "owned-view" } } : {},
      remoteTools: [],
      tools,
      assertCurrent: async () => {},
      prepareRemote: async () => {
        throw Error("No remote effect in this native fixture");
      },
      openModel: async (request) => {
        if (child) {
          if (!request.options.signal) throw new Error("Expected native model cancellation");
          held.resolve();
          await awaitWithContext(
            new Promise<void>(() => {}),
            withAbortSignal(request.options.signal, context),
          );
        }
        return { model: parentProvider.getModel(), options: request.options, release() {} };
      },
    });
    const delegate: ToolRegistration = {
      name: "delegate",
      description: "Owned native child fixture",
      parameters: Type.Object({}),
      execute: async (_args, api) => {
        delegations++;
        const id = await runtime.createConversation({
          requestId: "owned-child",
          ownerTaskId: api.taskId,
          parentConversationId: 1,
        });
        childConfig = config(id, true, []);
        const child = await runtime.bind(childConfig);
        original = await child.submit(
          { type: "input", content: "Original child input", requestId: runId },
          context,
        );
        await held.promise;
        queued = await child.submit(
          {
            type: "input",
            content: "Retained queued follow-up",
            requestId: "input-queued",
            whenBusy: "followUp",
          },
          context,
        );
        return { content: [{ type: "text", text: "Child remains active" }] };
      },
    };
    const options = {
      models,
      remoteTools: [],
      infrastructureTools: [delegate],
      settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
    };
    runtime = await DurableAgentSession.open(storage, options);
    let prefix: StorageWrite[][];
    try {
      const root = await runtime.bind(config(1, false, [delegate]));
      expect(
        (
          await (
            await root.submit({ type: "input", content: "Delegate", requestId: runId }, context)
          ).wait(context)
        ).status,
      ).toBe("done");
      prefix = structuredClone(journal);
    } finally {
      await runtime.close();
    }
    let commits = 0;
    const restored = new (class extends MemoryStorage {
      override async commit(writes: readonly StorageWrite[], ctx: Context) {
        commits++;
        return super.commit(writes, ctx);
      }
    })();
    for (const batch of prefix!) await restored.commit(batch, context);
    const next = await DurableAgentSession.open(restored, options);
    try {
      const root = await next.bind(config(1, false, [delegate]));
      const before = commits;
      await expect(
        next.bind(
          { ...childConfig, context: { ...childConfig.context, turnId: randomUUID() } },
          "reattach",
        ),
      ).rejects.toThrow("missing or changed");
      const child = await next.bind(
        {
          ...childConfig,
          agent: { instructions: "MUST NOT REPLACE NATIVE CONFIGURATION" },
          openModel: async (request) => {
            recoveredCalls++;
            return { model: childProvider.getModel(), options: request.options, release() {} };
          },
        },
        "reattach",
      );
      expect(commits).toBe(before);
      expect((await next.harness.snapshot(AgentDoc, child.id, context))?.instructions).toBe(
        "KEEP THE STORED CHILD INSTRUCTIONS",
      );
      expect((await restored.submissionByRequest(child.id, runId, context))?.id).toBe(original.id);
      expect((await restored.submissionByRequest(child.id, "input-queued", context))?.id).toBe(
        queued.id,
      );
      if (mode === "stop") await root.abort(context);
      else next.harness.resume();
      await root.waitForIdle(context);
      expect(delegations).toBe(1);
      expect(recoveredCalls).toBe(mode === "stop" ? 0 : 2);
      expect((await restored.submissionByRequest(child.id, "input-queued", context))?.status).toBe(
        mode === "stop" ? "unanswered" : "done",
      );
      const entries = await child.entries({}, 100, undefined, context);
      expect(
        entries.items.filter((entry) =>
          JSON.stringify(entry.model).includes("Original child input"),
        ),
      ).toHaveLength(1);
    } finally {
      await next.close();
    }
  },
);
