import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  MemoryStorage,
  AssistantEntry,
  type Conversation,
  type ConversationId,
  type Seq,
  type StorageWrite,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { BACKGROUND_CONTEXT as context, awaitWithContext } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import {
  createExecutionReference,
  infrastructureToolDefinitions,
  durableControlRecovery,
  type CandidateControlToolCommand,
  type DurableSessionCommit,
} from "@pi-cloud/protocol";
import { DurableAgentSession, type DurableRunConfiguration } from "../src/durable/agent-session.ts";

class Journal extends MemoryStorage {
  readonly commits: StorageWrite[][] = [];
  beforeAdopt?: (commit: DurableSessionCommit) => void;
  override async commit(writes: readonly StorageWrite[], _ctx: Context): Promise<Seq> {
    const prepared = this.prepareCommit(writes);
    this.beforeAdopt?.({
      seq: prepared.seq,
      nextId: 1000000,
      writes: prepared.writes,
    } as unknown as DurableSessionCommit);
    this.commits.push(structuredClone([...writes]));
    return prepared.apply();
  }
}

it("persists each dynamic hostcall once under its native Tool and retires its pending reference", async () => {
  const f = await family();
  const commands: CandidateControlToolCommand[] = [];
  f.storage.beforeAdopt = (commit) => {
    const prepared = f.runtime.preparePublication(commit);
    for (const effect of prepared.tools)
      if ("target" in effect.command && effect.command.target === "control")
        commands.push(effect.command);
    prepared.confirmed();
  };
  try {
    const inspection = await f.runtime.harness.inspect(context);
    const task = inspection.tasks.find(
      ({ record }) => record.kind === "pi.tool" && record.conversationId === f.childIds[0],
    )!.record;
    const command: CandidateControlToolCommand = {
      target: "control",
      executionReference: createExecutionReference(randomUUID(), f.runId, 1),
      operationId: randomUUID(),
      toolCallId: "task:" + task.id,
      nativeCallId: "task:" + task.id,
      conversationId: f.childIds[0]!,
      toolName: "subagent_control",
      replyMode: "hostcall",
      arguments: { action: "status", target: "fixture" },
      contextAnchor: null,
      occurredAt: new Date().toISOString(),
    };
    await f.runtime.publishControl(task.id, command);
    await f.runtime.publishControl(task.id, command);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.sourceDocumentId).toBeGreaterThan(0);
    await expect(
      f.runtime.publishControl(task.id, {
        ...command,
        arguments: { action: "status", target: "changed" },
      }),
    ).rejects.toThrow("identity changed");
    await f.runtime.retireHostCall(task.id, command.operationId);
    const record = await f.storage.findDocument(
      {
        kind: "pi-cloud.tool-hostcall",
        scope: { kind: "task", taskId: task.id },
        key: command.operationId,
      },
      "current",
      context,
    );
    expect(record).toBeUndefined();
    await f.children[0]!.abort(context);
    await expect(
      f.runtime.publishControl(task.id, {
        ...command,
        operationId: randomUUID(),
      }),
    ).rejects.toThrow("invocation has ended");
    expect(commands).toHaveLength(1);
  } finally {
    await f.runtime.close();
  }
}, 15000);

it("publishes an ordered native recovery reference before resolving a recovered remote Tool", async () => {
  const models = createModels(),
    provider = fauxProvider({ tokensPerSecond: 1_000_000 });
  models.setProvider(provider.provider);
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("subagent", { task: "One original task" }), {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("DONE"),
  ]);
  const runId = randomUUID();
  const sourceId = randomUUID();
  const waiting = Promise.withResolvers<void>();
  const reply = Promise.withResolvers<import("@earendil-works/pi-durable").ToolExecutionResult>();
  let epoch = 1,
    normal = 0,
    resumed = 0,
    originalSequence = 0;
  const effects: Array<{ taskId: number; command: CandidateControlToolCommand }> = [];
  let runtime!: DurableAgentSession;
  const definition = infrastructureToolDefinitions().find((tool) => tool.name === "subagent")!;
  const configure = (): DurableRunConfiguration => ({
    runId,
    conversationId: 1,
    model: provider.getModel(),
    agent: {},
    context: {},
    remoteTools: () => ["subagent"],
    tools: [],
    assertCurrent: async () => {},
    openModel: async (request) => ({
      model: provider.getModel(),
      options: request.options,
      release() {},
    }),
    prepareRemote: async (invocation) => {
      if (invocation.recovery) resumed++;
      else normal++;
      const command: CandidateControlToolCommand = {
        target: "control",
        toolName: "subagent",
        toolCallId: `task:${invocation.taskId}`,
        nativeCallId: invocation.callId,
        arguments: invocation.args,
        conversationId: 1,
        executionReference: createExecutionReference(randomUUID(), runId, epoch),
        operationId: invocation.recovery ? randomUUID() : sourceId,
        contextAnchor: null,
        occurredAt: new Date().toISOString(),
        ...(invocation.recovery
          ? { recovery: { sequence: originalSequence, operationId: sourceId } }
          : {}),
      };
      return {
        command,
        completed: () => false,
        dispose() {},
        result: async () => {
          if (invocation.recovery) return reply.promise;
          waiting.resolve();
          await awaitWithContext(new Promise(() => {}), invocation.context);
          throw new Error("Old invocation must be interrupted");
        },
      };
    },
  });
  const open = async (store: Journal) => {
    runtime = await DurableAgentSession.open(store, {
      models,
      remoteTools: [definition],
      settings: { compaction: { enabled: false } },
    });
    store.beforeAdopt = (commit) => {
      const prepared = runtime.preparePublication(commit);
      for (const effect of prepared.tools) {
        if (!("target" in effect.command) || effect.command.target !== "control")
          throw new Error("Unexpected physical execution");
        effects.push({ taskId: effect.taskId, command: effect.command });
        if (effect.command.recovery) {
          const recovery = effect.command.recovery;
          expect(recovery.documentId).toBeDefined();
          expect(
            durableControlRecovery(commit, {
              taskId: effect.taskId,
              operationId: effect.command.operationId,
              recovery: { ...recovery, documentId: recovery.documentId! },
            }),
          ).toEqual({ sequence: originalSequence, operationId: sourceId });
          // Deliberately faster than publication ACK/native adoption.
          reply.resolve({ content: [{ type: "text", text: "ORIGINAL CHILD RESULT" }] });
        } else originalSequence = commit.seq;
      }
      prepared.confirmed();
    };
    return runtime;
  };
  const storage = new Journal();
  await open(storage);
  try {
    const root = await runtime.bind(configure());
    await root.submit({ type: "input", content: "Delegate", requestId: runId }, context);
    await waiting.promise;
    await runtime.close();
    epoch++;
    const restored = new Journal();
    for (const writes of storage.commits) await restored.commit(writes, context);
    await open(restored);
    const rootRestored = await runtime.bind(configure(), "reattach");
    runtime.harness.resume();
    await runtime.harness.waitForIdle(context);
    expect(normal).toBe(1);
    expect(resumed).toBe(1);
    expect(effects).toHaveLength(2);
    expect(effects[0]!.taskId).toBe(effects[1]!.taskId);
    expect(effects[1]!.command.operationId).not.toBe(sourceId);
    expect(effects[1]!.command.recovery?.operationId).toBe(sourceId);
    const results = (await rootRestored.context(context)).messages.filter(
      (message) => message.role === "toolResult" && message.toolName === "subagent",
    );
    expect(results).toHaveLength(1);
    expect(JSON.stringify(results)).toContain("ORIGINAL CHILD RESULT");
  } finally {
    await runtime.close();
  }
}, 15_000);

it.each(["created", "configured", "submitted", "completed", "stop"] as const)(
  "public safe delegation resumes its original generation-owned child after %s",
  async (stage) => {
    // Native API proof only. Management transport is represented by the existing
    // creation adapter; PG authority/Kafka delivery are separate integration gates.
    const runId = randomUUID();
    const models = createModels();
    const parentModel = fauxProvider({ provider: "safe-parent", tokensPerSecond: 1_000_000 });
    const childModel = fauxProvider({ provider: "safe-child", tokensPerSecond: 1_000_000 });
    models.setProvider(parentModel.provider);
    models.setProvider(childModel.provider);
    parentModel.setResponses([
      fauxAssistantMessage(fauxToolCall("delegate", {}, { id: "parent-delegate" }), {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("PARENT DONE"),
    ]);
    childModel.setResponses([
      fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
      fauxAssistantMessage("CHILD ORIGINAL"),
      fauxAssistantMessage("CHILD LATER"),
    ]);
    let boot = 0,
      executions = 0,
      preparations = 0,
      unsafeCalls = 0;
    const reached = Promise.withResolvers<void>();
    const holdEntered = Promise.withResolvers<void>();
    const never = new Promise<void>(() => {});
    const children = new Set<number>();
    const callerIds = new Set<number>();
    let runtime!: DurableAgentSession;
    const gate = async (at: string, ctx: Context) => {
      if (boot === 0 && at === (stage === "stop" ? "submitted" : stage)) {
        reached.resolve();
        await awaitWithContext(never, ctx);
      }
    };
    const hold: ToolRegistration = {
      name: "hold",
      description: "Owned unsafe effect",
      parameters: Type.Object({}),
      replay: "unsafe",
      async execute(_args, _api, ctx) {
        unsafeCalls++;
        holdEntered.resolve();
        if (boot === 0 && (stage === "submitted" || stage === "stop"))
          await awaitWithContext(never, ctx);
        return { content: [{ type: "text", text: "effect finished" }] };
      },
    };
    const delegate: ToolRegistration = {
      name: "delegate",
      description: "Recover one original child",
      parameters: Type.Object({}),
      replay: "safe",
      prepareArguments(args) {
        preparations++;
        return args;
      },
      async execute(_args, api, ctx) {
        executions++;
        callerIds.add(api.taskId);
        const current = runtime;
        const id = await current.createConversation({
          requestId: `delegate:${api.taskId}`,
          parentConversationId: api.conversationId,
          ownerTaskId: api.taskId,
        });
        children.add(id);
        await gate("created", ctx);
        const originalInput = await current.storage.submissionByRequest(
          id as ConversationId,
          runId,
          ctx,
        );
        const child = await current.bind(
          configuration(id, [hold], true),
          originalInput ? "reattach" : "initialize",
        );
        await gate("configured", ctx);
        const submission = await child.submit(
          { type: "input", content: "Original delegated task", requestId: runId },
          ctx,
        );
        if (boot === 0 && (stage === "submitted" || stage === "stop"))
          await awaitWithContext(holdEntered.promise, ctx);
        await gate("submitted", ctx);
        const settled = await submission.wait(ctx);
        if (settled.status !== "done" || settled.type !== "input")
          throw new Error("Child did not finish its original input");
        await gate("completed", ctx);
        const entry = await api.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
        const answer = entry?.model?.[0];
        if (!answer || answer.role !== "assistant") throw new Error("Original answer missing");
        return {
          content: [
            {
              type: "text",
              text: answer.content
                .filter((p) => p.type === "text")
                .map((p) => p.text)
                .join(""),
            },
          ],
          details: { conversationId: id },
        };
      },
    };
    function configuration(
      conversationId: number,
      tools: ToolRegistration[],
      child = false,
    ): DurableRunConfiguration {
      const provider = child ? childModel : parentModel;
      return {
        runId,
        conversationId,
        model: provider.getModel(),
        agent: {},
        context: {},
        remoteTools: () => [],
        tools,
        assertCurrent: async () => {},
        prepareRemote: async () => {
          throw new Error("No external effects in native proof");
        },
        openModel: async (request) => ({
          model: provider.getModel(),
          options: request.options,
          release() {},
        }),
      };
    }
    const open = (store: MemoryStorage) =>
      DurableAgentSession.open(store, {
        models,
        remoteTools: [],
        infrastructureTools: [delegate, hold],
        settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
      });
    const storage = new Journal();
    runtime = await open(storage);
    try {
      const root = await runtime.bind(configuration(1, [delegate]));
      await root.submit({ type: "input", content: "Delegate once", requestId: runId }, context);
      await reached.promise;
      expect(children.size).toBe(1);
      const childId = [...children][0]! as ConversationId;
      if (stage === "completed") {
        // A later child answer must not replace the original delegation outcome.
        const child = (await runtime.harness.conversation(childId, context))!;
        await (
          await child.submit(
            { type: "input", content: "A separate later question", requestId: "later-input" },
            context,
          )
        ).wait(context);
      }
      await runtime.close();
      boot = 1;
      const restored = new MemoryStorage();
      for (const writes of storage.commits) await restored.commit(writes, context);
      runtime = await open(restored);
      const rootRestored = await runtime.bind(configuration(1, [delegate]), "reattach");
      const existingInput = await restored.submissionByRequest(childId, runId, context);
      if (existingInput) await runtime.bind(configuration(childId, [hold], true), "reattach");
      if (stage === "stop") await rootRestored.abort(context);
      else runtime.harness.resume();
      await runtime.harness.waitForIdle(context);
      expect(children.size).toBe(1);
      expect(callerIds.size).toBe(1);
      expect(preparations).toBe(1); // Recovery bypasses original Tool preparation.
      expect(unsafeCalls).toBe(1);
      expect((await restored.scanConversations({}, 10, undefined, context)).items).toHaveLength(2);
      const inputs = await restored.scanSubmissions(
        { conversationId: childId },
        10,
        undefined,
        context,
      );
      expect(inputs.items.filter((input) => input.requestId === runId)).toHaveLength(1);
      const rootInput = await restored.submissionByRequest(1 as ConversationId, runId, context);
      if (stage === "stop") {
        expect(rootInput).toMatchObject({ status: "unanswered", reason: "aborted" });
      } else {
        expect(executions).toBe(2);
        expect(rootInput).toMatchObject({ status: "done" });
        const results = (await rootRestored.context(context)).messages.filter(
          (message) => message.role === "toolResult" && message.toolName === "delegate",
        );
        expect(results).toHaveLength(1);
        expect(JSON.stringify(results)).toContain("CHILD ORIGINAL");
        expect(JSON.stringify(results)).not.toContain("CHILD LATER");
      }
    } finally {
      await runtime.close();
    }
  },
  15_000,
);

it("persists cancellation before creation so a late management request cannot start a child", async () => {
  const f = await family();
  const task = (await f.runtime.harness.inspect(context)).tasks.find(
    ({ record }) => record.kind === "pi.tool" && record.conversationId === f.childIds[1],
  )!.record;
  const request = {
    requestId: "cancel-before-create",
    parentConversationId: f.childIds[1]!,
    ownerTaskId: task.id,
  };
  await f.runtime.stopConversation(request.requestId);
  await expect(f.runtime.createConversation(request)).rejects.toThrow("creation was cancelled");
  await f.runtime.close();
  const restored = new MemoryStorage();
  for (const batch of f.storage.commits) await restored.commit(batch, context);
  const next = await f.open(restored);
  try {
    await expect(next.createConversation(request)).rejects.toThrow("creation was cancelled");
  } finally {
    await next.close();
  }
}, 15000);

async function family() {
  const runId = randomUUID(),
    models = createModels();
  const providers = ["main", "a", "b"].map((name) => {
    const provider = fauxProvider({ provider: name, tokensPerSecond: 1_000_000 });
    models.setProvider(provider.provider);
    return provider;
  });
  providers[0]!.setResponses([
    fauxAssistantMessage(fauxToolCall("delegate", {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("MAIN ANSWER"),
  ]);
  for (const [index, provider] of providers.entries())
    if (index)
      provider.setResponses([
        fauxAssistantMessage(fauxToolCall("hold", {}), { stopReason: "toolUse" }),
        fauxAssistantMessage(`CHILD ${index} DONE`),
      ]);
  const arrived = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const releases = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const childIds: number[] = [],
    toolCalls = [0, 0];
  const storage = new Journal();
  let runtime!: DurableAgentSession;
  const children: Conversation[] = [];
  function hold(index: number): ToolRegistration {
    return {
      name: "hold",
      description: "Wait for external completion",
      parameters: Type.Object({}),
      replay: "unsafe",
      async execute(_args, _api, ctx) {
        toolCalls[index] = (toolCalls[index] ?? 0) + 1;
        arrived[index]!.resolve();
        await awaitWithContext(releases[index]!.promise, ctx);
        return { content: [{ type: "text", text: `RESULT ${index}` }] };
      },
    };
  }
  const delegate: ToolRegistration = {
    name: "delegate",
    description: "Create ordinary children in the current native family",
    parameters: Type.Object({}),
    async execute(_args, api) {
      for (let index = 0; index < 2; index++) {
        const id = await runtime.createConversation({
          requestId: `child-${index}`,
          parentConversationId: api.conversationId,
          ownerTaskId: api.taskId,
        });
        childIds[index] = id;
        const child = await runtime.bind(configuration(id, index + 1, [hold(index)]));
        children[index] = child;
        await child.submit(
          { type: "input", content: `WORK ${index}`, requestId: `child-input-${index}` },
          context,
        );
      }
      await Promise.all(arrived.map((item) => item.promise));
      return { content: [{ type: "text", text: "Children are waiting for decisions" }] };
    },
  };
  function configuration(
    conversationId: number,
    providerIndex: number,
    tools: ToolRegistration[],
  ): DurableRunConfiguration {
    return {
      runId,
      conversationId,
      model: providers[providerIndex]!.getModel(),
      agent: {},
      context: {},
      remoteTools: () => [],
      tools,
      assertCurrent: async () => {},
      prepareRemote: async () => {
        throw new Error("No remote transport in native contract");
      },
      openModel: async (request, native) => {
        expect(request.runId).toBe(runId);
        expect(request.conversationId).toBe(conversationId);
        expect(native?.conversationId).toBe(conversationId);
        return {
          model: providers[providerIndex]!.getModel(),
          options: request.options,
          release() {},
        };
      },
    };
  }
  const open = (store: MemoryStorage) =>
    DurableAgentSession.open(store, {
      models,
      remoteTools: [],
      infrastructureTools: [delegate, hold(0)],
      settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
    });
  runtime = await open(storage);
  const parent = await runtime.bind(configuration(1, 0, [delegate]));
  const input = await parent.submit(
    { type: "input", content: "Delegate two children", requestId: runId },
    context,
  );
  await Promise.all(arrived.map((item) => item.promise));
  expect((await input.wait(context)).status).toBe("done");
  return {
    runId,
    runtime,
    storage,
    children,
    childIds,
    releases,
    providers,
    toolCalls,
    configuration,
    open,
  };
}

it("cancels one native child without completing its sibling or the root work", async () => {
  const f = await family();
  try {
    let idle = false;
    const finished = f.runtime.harness.waitForIdle(context).then(() => {
      idle = true;
    });
    await f.children[0]!.abort(context);
    f.runtime.detach(f.runId, f.childIds[0]!);
    expect(
      await f.storage.submissionByRequest(
        f.childIds[0]! as ConversationId,
        "child-input-0",
        context,
      ),
    ).toMatchObject({ status: "unanswered", reason: "aborted" });
    expect(
      await f.storage.submissionByRequest(
        f.childIds[1]! as ConversationId,
        "child-input-1",
        context,
      ),
    ).toMatchObject({ status: "placed" });
    expect(idle).toBe(false);
    f.releases[1]!.resolve();
    await finished;
    expect(
      await f.storage.submissionByRequest(
        f.childIds[1]! as ConversationId,
        "child-input-1",
        context,
      ),
    ).toMatchObject({ status: "done" });
    expect(f.toolCalls).toEqual([1, 1]);
    expect(f.providers.map((provider) => provider.state.callCount)).toEqual([2, 1, 2]);
  } finally {
    await f.runtime.close();
  }
}, 15000);

it("reopens multiple native children under the same logical Run without replaying unsafe tools", async () => {
  const f = await family();
  // Closing the native owner preserves resumable tasks. No cloud child queue
  // or extra logical Run exists in either storage or the restored fixture.
  await f.runtime.close();
  const restored = new MemoryStorage();
  for (const writes of f.storage.commits) await restored.commit(writes, context);
  const next = await f.open(restored);
  try {
    const forbidden: ToolRegistration = {
      name: "hold",
      description: "Interrupted unsafe effect",
      parameters: Type.Object({}),
      replay: "unsafe",
      async execute() {
        throw new Error("Unsafe child tool must not be replayed");
      },
    };
    await next.bind(f.configuration(1, 0, []));
    for (const [index, id] of f.childIds.entries())
      await next.bind(f.configuration(id, index + 1, [forbidden]));
    await next.harness.waitForIdle(context);
    expect(f.toolCalls).toEqual([1, 1]);
    for (const [index, id] of f.childIds.entries()) {
      const conversation = await next.harness.conversation(id as ConversationId, context);
      const messages = JSON.stringify((await conversation!.context(context)).messages);
      expect(messages).toContain("interrupted and may have partially run");
      expect(messages).toContain(`CHILD ${index + 1} DONE`);
      expect(
        await restored.submissionByRequest(id as ConversationId, `child-input-${index}`, context),
      ).toMatchObject({ status: "done" });
    }
    expect(f.providers[0]!.state.callCount).toBe(2);
  } finally {
    await next.close();
  }
}, 15000);
