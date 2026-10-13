import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  MemoryStorage,
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
      if ("target" in effect.command) commands.push(effect.command);
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
      toolName: "subagent",
      replyMode: "hostcall",
      arguments: { action: "status", target: "fixture" },
      contextAnchor: null,
      occurredAt: new Date().toISOString(),
    };
    await f.runtime.publishHostCall(task.id, command);
    await f.runtime.publishHostCall(task.id, command);
    expect(commands).toHaveLength(1);
    expect(commands[0]!.sourceDocumentId).toBeGreaterThan(0);
    await expect(
      f.runtime.publishHostCall(task.id, {
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
      f.runtime.publishHostCall(task.id, {
        ...command,
        operationId: randomUUID(),
      }),
    ).rejects.toThrow("invocation has ended");
    expect(commands).toHaveLength(1);
  } finally {
    await f.runtime.close();
  }
}, 15000);

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
      remoteTools: [],
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
