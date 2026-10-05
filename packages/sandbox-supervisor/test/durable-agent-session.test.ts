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

async function fixture(options: { hold?: boolean; invalid?: boolean; duplicate?: boolean } = {}) {
  const models = createModels(),
    faux = fauxProvider({ tokensPerSecond: 1_000_000 });
  models.setProvider(faux.provider);
  const call = fauxToolCall("bash", options.invalid ? {} : { command: "one effect" });
  faux.setResponses([
    fauxAssistantMessage(options.duplicate ? [call, structuredClone(call)] : call, {
      stopReason: "toolUse",
    }),
    fauxAssistantMessage("DONE"),
  ]);
  let runtime: DurableAgentSession | undefined;
  const started = Promise.withResolvers<void>();
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
      for (const { command } of effects?.tools ?? []) {
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
  const definition = {
    name: "bash",
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
    remoteTools: ["bash"],
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
            turnContextSha256: "a".repeat(64),
            executionContextSha256: "b".repeat(64),
            stepContextSequence: 1,
            stepContextSha256: "c".repeat(64),
            operation: "tool.execute",
            toolName: "bash",
            toolCallId: invocation.callId,
            args: invocation.args,
            timeoutMs: 1000,
            maximumOutputBytes: 65536,
          },
        },
        result: () => awaitWithContext(reply.promise, invocation.context),
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
    prepared: () => preparedCount,
  };
}

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
