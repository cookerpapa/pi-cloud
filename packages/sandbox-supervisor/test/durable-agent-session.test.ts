import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { MemoryStorage, type StorageWrite, type Seq } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT, awaitWithContext } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { Type } from "@earendil-works/pi-ai";
import {
  createExecutionReference,
  type DurableSessionCommit,
  type CandidateToolCommand,
} from "@pi-cloud/protocol";
import { DurableAgentSession } from "../src/durable/agent-session.ts";
import type { RemoteInvocation } from "../src/durable/remote-tools.ts";
import { fixedRemoteToolDefinitions } from "../src/fixed-remote-tool-definitions.ts";

async function fixture(
  options: { hold?: boolean; invalid?: boolean; duplicate?: boolean; parallelReads?: boolean } = {},
) {
  const models = createModels(),
    faux = fauxProvider({ tokensPerSecond: 1_000_000 });
  models.setProvider(faux.provider);
  const name = options.parallelReads ? "read" : "bash";
  const call = fauxToolCall(
    name,
    options.invalid
      ? {}
      : options.parallelReads
        ? { path: "first.txt" }
        : { command: "one effect" },
  );
  faux.setResponses([
    fauxAssistantMessage(
      options.parallelReads
        ? [call, fauxToolCall("read", { path: "second.txt" })]
        : options.duplicate
          ? [call, structuredClone(call)]
          : call,
      {
        stopReason: "toolUse",
      },
    ),
    fauxAssistantMessage("DONE"),
  ]);
  let runtime: DurableAgentSession | undefined;
  const started = Promise.withResolvers<void>();
  const bothExecuting = Promise.withResolvers<void>();
  const effectBatches: { seq: number; tools: number }[] = [];
  let executing = 0;
  const reply = Promise.withResolvers<import("@earendil-works/pi-durable").ToolExecutionResult>();
  const commits: StorageWrite[][] = [],
    commands: CandidateToolCommand[] = [],
    cancels: string[] = [];
  let preparedCount = 0,
    received = false;
  const store = new (class extends MemoryStorage {
    override async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
      const prepared = this.prepareCommit(writes);
      const effects = runtime?.remote.preparePublication({
        seq: prepared.seq,
        nextId: 100,
        writes: prepared.writes,
      } as unknown as DurableSessionCommit);
      commits.push(structuredClone([...writes]));
      if (effects?.tools.length)
        effectBatches.push({ seq: Number(prepared.seq), tools: effects.tools.length });
      for (const { command } of effects?.tools ?? []) {
        if (!("request" in command)) throw new Error("Expected the Cube fixture");
        commands.push(command);
        started.resolve();
        if (!options.hold) {
          received = true;
          reply.resolve({ content: [{ type: "text", text: "ONE" }] });
        }
      }
      for (const cancel of effects?.cancellations ?? []) {
        cancels.push(cancel.operationId);
        received = true;
        reply.resolve({
          content: [{ type: "text", text: "LATE CONFIRMED PARTIAL" }],
          isError: true,
        });
      }
      effects?.confirmed();
      return prepared.apply();
    }
  })();
  const definition = options.parallelReads
    ? fixedRemoteToolDefinitions().find((tool) => tool.name === "read")!
    : {
        name,
        description: "Test transport only",
        parameters: Type.Object({ command: Type.String() }),
      };
  runtime = await DurableAgentSession.open(store, {
    models,
    remoteTools: [definition],
    settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
  });
  const runId = randomUUID(),
    reference = createExecutionReference(randomUUID(), runId, 1);
  const conversation = await runtime.bind({
    runId,
    conversationId: 1,
    model: faux.getModel(),
    agent: {},
    context: { sessionId: randomUUID(), turnId: randomUUID() },
    remoteTools: [name],
    tools: [],
    assertCurrent: async () => {},
    openModel: async ({ options: request }) => ({
      model: faux.getModel(),
      options: { ...request, apiKey: "private-model-capability" },
      release: () => {},
    }),
    prepareRemote: async (invocation: RemoteInvocation) => {
      preparedCount++;
      return {
        command: {
          executionReference: reference,
          toolCallId: `task:${invocation.taskId}`,
          occurredAt: new Date().toISOString(),
          request: {
            toolBrokerProtocolVersion: 1,
            type: "tool_sandbox.operation",
            activationId: randomUUID(),
            operationId: randomUUID(),

            operation: "tool.execute",
            toolName: name,
            toolCallId: invocation.callId,
            args: invocation.args,
            timeoutMs: 1000,
            maximumOutputBytes: 65536,
          },
        },
        result: () => {
          executing++;
          if (executing === 2) bothExecuting.resolve();
          return awaitWithContext(reply.promise, invocation.context).finally(() => executing--);
        },
        completed: () => received,
        dispose: () => {},
      };
    },
  });
  return {
    runtime,
    runId,
    definition,
    conversation,
    faux,
    commands,
    cancels,
    started,
    commits,
    effectBatches,
    bothExecuting,
    finishTools: () => {
      received = true;
      reply.resolve({ content: [{ type: "text", text: "ONE" }] });
    },
    prepared: () => preparedCount,
  };
}

it("keeps concurrent native read execution intents in separate commits without serializing execution", async () => {
  const f = await fixture({ hold: true, parallelReads: true });
  try {
    const input = await f.conversation.submit(
      { type: "input", content: "Read both files" },
      BACKGROUND_CONTEXT,
    );
    await f.bothExecuting.promise;
    expect(f.commands).toHaveLength(2);
    expect(f.effectBatches.map((batch) => batch.tools)).toEqual([1, 1]);
    expect(f.effectBatches[1]!.seq).toBeGreaterThan(f.effectBatches[0]!.seq);
    expect(f.faux.state.callCount).toBe(1);
    f.finishTools();
    expect((await input.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    expect(f.faux.state.callCount).toBe(2);
  } finally {
    await f.runtime.close();
  }
});

it("executes a remote Tool only with the native post-validation intent and keeps secrets outside storage", async () => {
  const f = await fixture();
  try {
    const input = await f.conversation.submit(
      { type: "input", content: "go", requestId: "input" },
      BACKGROUND_CONTEXT,
    );
    expect((await input.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    expect(f.commands).toHaveLength(1);
    expect(f.prepared()).toBe(1);
    expect(f.faux.state.callCount).toBe(2);
    expect(JSON.stringify(f.commits)).not.toContain("private-model-capability");
    expect(JSON.stringify((await f.conversation.context(BACKGROUND_CONTEXT)).messages)).toContain(
      "ONE",
    );
  } finally {
    await f.runtime.close();
  }
});

it("leaves invalid arguments to native Pi validation without preparing or dispatching an effect", async () => {
  const f = await fixture({ invalid: true });
  try {
    const input = await f.conversation.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT);
    expect((await input.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    expect(f.commands).toHaveLength(0);
    expect(f.prepared()).toBe(0);
  } finally {
    await f.runtime.close();
  }
});

it("co-commits operation cancellation with native abort and adopts native late-result semantics", async () => {
  const f = await fixture({ hold: true });
  try {
    await f.conversation.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT);
    await f.started.promise;
    await f.conversation.abort(BACKGROUND_CONTEXT);
    expect(f.cancels).toEqual([f.commands[0]!.request.operationId]);
    const entries = await f.conversation.entries({}, 100, undefined, BACKGROUND_CONTEXT);
    expect(JSON.stringify(entries)).not.toContain("LATE CONFIRMED PARTIAL");
    expect(JSON.stringify(entries)).toContain("aborted");
    expect(f.faux.state.callCount).toBe(1);
  } finally {
    await f.runtime.close();
  }
});

it("restores an interrupted unsafe Tool without replay and waits for the recovered cloud grant before sampling", async () => {
  const first = await fixture({ hold: true });
  await first.conversation.submit(
    { type: "input", content: "go", requestId: "original-input" },
    BACKGROUND_CONTEXT,
  );
  await first.started.promise;
  await first.runtime.close();
  const restored = new MemoryStorage();
  for (const writes of first.commits) await restored.commit(writes, BACKGROUND_CONTEXT);
  const models = createModels(),
    provider = first.faux;
  models.setProvider(provider.provider);
  provider.setResponses([fauxAssistantMessage("RECOVERED")]);
  const callsBefore = provider.state.callCount;
  const next = await DurableAgentSession.open(restored, {
    models,
    remoteTools: [first.definition],
    settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
  });
  try {
    next.harness.resume();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(provider.state.callCount).toBe(callsBefore);
    let prepared = 0;
    const conversation = await next.bind({
      runId: first.runId,
      conversationId: 1,
      model: provider.getModel(),
      agent: {},
      context: {},
      remoteTools: ["bash"],
      tools: [],
      assertCurrent: async () => {},
      prepareRemote: async () => {
        prepared++;
        throw new Error("Unsafe Tool must not be replayed");
      },
      openModel: async (request) => ({
        model: provider.getModel(),
        options: request.options,
        release: () => {},
      }),
    });
    await conversation.waitForIdle(BACKGROUND_CONTEXT);
    expect(prepared).toBe(0);
    expect(first.commands).toHaveLength(1);
    expect(provider.state.callCount).toBe(callsBefore + 1);
    const context = JSON.stringify((await conversation.context(BACKGROUND_CONTEXT)).messages);
    expect(context).toContain("interrupted and may have partially run");
    expect(context).toContain("RECOVERED");
    expect(
      (await restored.submissionByRequest(conversation.id, "original-input", BACKGROUND_CONTEXT))
        ?.status,
    ).toBe("done");
  } finally {
    await next.close();
  }
});

it("rejects duplicate provider call IDs within one response before executing either effect", async () => {
  const f = await fixture({ duplicate: true });
  try {
    const input = await f.conversation.submit({ type: "input", content: "go" }, BACKGROUND_CONTEXT);
    expect((await input.wait(BACKGROUND_CONTEXT)).status).toBe("unanswered");
    expect(f.prepared()).toBe(0);
    expect(f.commands).toHaveLength(0);
  } finally {
    await f.runtime.close();
  }
});

it.each(["reply", "abort", "early-answer"] as const)(
  "shares one root Run across parent/child models and preserves native parent %s",
  async (mode) => {
    const models = createModels(),
      parentModel = fauxProvider({ provider: "parent-fixture", tokensPerSecond: 1000000 }),
      childModel = fauxProvider({ provider: "child-fixture", tokensPerSecond: 1000000 });
    models.setProvider(parentModel.provider);
    models.setProvider(childModel.provider);
    parentModel.setResponses([
      fauxAssistantMessage(fauxToolCall("delegate", {}), { stopReason: "toolUse" }),
      ...(mode === "early-answer"
        ? []
        : [fauxAssistantMessage(fauxToolCall("reply", {}), { stopReason: "toolUse" })]),
      fauxAssistantMessage("PARENT DONE"),
    ]);
    childModel.setResponses([
      fauxAssistantMessage(fauxToolCall("ask", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("CHILD DONE"),
    ]);
    const asked = Promise.withResolvers<void>(),
      reply = Promise.withResolvers<void>(),
      reached = Promise.withResolvers<void>();
    const storage = new MemoryStorage();
    let runtime!: DurableAgentSession,
      childInput: import("@earendil-works/pi-durable").Submission | undefined;
    let childId = 0,
      callerId = 0;
    const parentRun = randomUUID();
    const ask = {
      name: "ask",
      description: "request a decision",
      parameters: Type.Object({}),
      execute: async (_args: unknown, _api: unknown, context: Context) => {
        asked.resolve();
        await awaitWithContext(reply.promise, context);
        return { content: [{ type: "text" as const, text: "TEAL" }] };
      },
    };
    const tools: import("@earendil-works/pi-durable").ToolRegistration[] = [
      {
        name: "delegate",
        description: "start a child",
        parameters: Type.Object({}),
        execute: async (_args, api) => {
          callerId = api.taskId;
          const creation = {
            requestId: "child",
            ownerTaskId: api.taskId,
            parentConversationId: api.conversationId,
          };
          childId = await runtime.createConversation(creation);
          expect(await runtime.createConversation(creation)).toBe(childId);
          await expect(
            runtime.createConversation({ ...creation, ownerTaskId: api.taskId + 1 }),
          ).rejects.toThrow("identity was reused");
          const child = await runtime.bind(
            config(parentRun, childId, childModel.getModel(), [ask]),
          );
          childInput = await child.submit(
            { type: "input", content: "ask", requestId: "child-input" },
            BACKGROUND_CONTEXT,
          );
          await asked.promise;
          return { content: [{ type: "text", text: "blocked: reply requested" }] };
        },
      },
      {
        name: "reply",
        description: "reply to the existing child",
        parameters: Type.Object({}),
        execute: async (_args, _api, context) => {
          reached.resolve();
          if (mode === "abort") await awaitWithContext(new Promise<void>(() => {}), context);
          reply.resolve();
          expect((await childInput!.wait(BACKGROUND_CONTEXT)).status).toBe("done");
          return { content: [{ type: "text", text: "child completed" }] };
        },
      },
    ];
    function config(
      runId: string,
      conversationId: number,
      model: import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api>,
      definitions: import("@earendil-works/pi-durable").ToolRegistration[],
    ) {
      return {
        runId,
        conversationId,
        model,
        agent: {},
        context: {},
        remoteTools: [],
        tools: definitions,
        assertCurrent: async () => {},
        prepareRemote: async () => {
          throw new Error("no remote effect");
        },
        openModel: async (request: import("../src/durable/scoped-models.ts").CloudModelRequest) => {
          expect(request.runId).toBe(parentRun);
          expect(request.conversationId).toBe(conversationId);
          return { model, options: { ...request.options, apiKey: "fixture" }, release() {} };
        },
      };
    }
    runtime = await DurableAgentSession.open(storage, {
      models,
      remoteTools: [],
      infrastructureTools: [...tools, ask],
      settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
    });
    try {
      const parent = await runtime.bind(config(parentRun, 1, parentModel.getModel(), tools));
      const input = await parent.submit(
        { type: "input", content: "delegate and supervise", requestId: parentRun },
        BACKGROUND_CONTEXT,
      );
      if (mode === "early-answer") {
        expect((await input.wait(BACKGROUND_CONTEXT)).status).toBe("done");
      } else await reached.promise;
      const conversation = await storage.conversation(
        childId as import("@earendil-works/pi-durable").ConversationId,
        BACKGROUND_CONTEXT,
      );
      const caller = await storage.task(
        callerId as import("@earendil-works/pi-durable").TaskId,
        BACKGROUND_CONTEXT,
      );
      expect(conversation?.owner?.taskId).toBe(caller?.owner);
      if (mode === "early-answer") {
        const context = await parent.context(BACKGROUND_CONTEXT);
        expect(
          context.entries.some((entry) =>
            entry.model?.some(
              (message) =>
                message.role === "assistant" &&
                message.content.some((part) => part.type === "text" && part.text === "PARENT DONE"),
            ),
          ),
        ).toBe(true);
        const inspection = await runtime.harness.inspect(BACKGROUND_CONTEXT);
        expect(
          inspection.tasks.some(
            ({ record }) => record.id === caller?.owner && record.state.status === "completing",
          ),
        ).toBe(true);
        expect(inspection.tasks.some(({ record }) => record.conversationId === childId)).toBe(true);
        let idle = false;
        // This is the same descendant-aware boundary the cloud Run waits for.
        const idleWait = parent.waitForIdle(BACKGROUND_CONTEXT).then(() => {
          idle = true;
        });
        await runtime.harness.inspect(BACKGROUND_CONTEXT);
        expect(idle).toBe(false);
        reply.resolve();
        await idleWait;
        expect((await childInput!.wait(BACKGROUND_CONTEXT)).status).toBe("done");
        expect(idle).toBe(true);
      } else if (mode === "abort") {
        await parent.abort(BACKGROUND_CONTEXT);
        expect(await input.wait(BACKGROUND_CONTEXT)).toMatchObject({
          status: "unanswered",
          reason: "aborted",
        });
        expect(await childInput!.wait(BACKGROUND_CONTEXT)).toMatchObject({
          status: "unanswered",
          reason: "aborted",
        });
      } else expect((await input.wait(BACKGROUND_CONTEXT)).status).toBe("done");
    } finally {
      reply.resolve();
      await runtime.close();
    }
  },
  15000,
);
