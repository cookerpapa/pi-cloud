import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  Type,
  type AssistantMessage,
  type AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  createRegistry,
  defineExtension,
  defineTool,
  Harness,
  MemoryStorage,
  type StorageWrite,
  type TaskId,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { ScopedDurableModels } from "../src/durable/scoped-models.ts";
import { DurableRunEvents } from "../src/durable/run-events.ts";
import type { PiCloudEventBody } from "@pi-cloud/protocol";

/** First response is externally paced; later requests use Pi's scripted provider. */
function controlledProvider() {
  const base = createModels(),
    faux = fauxProvider({ tokensPerSecond: 1_000_000 });
  base.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("RECOVERED OR COMPLETE")]);
  const stream = createAssistantMessageEventStream(),
    started = Promise.withResolvers<void>();
  let first = true,
    partial = fauxAssistantMessage([], { stopReason: "pending" }),
    detach = () => {};
  const finish = (reason: Exclude<AssistantMessage["stopReason"], "pending">) => {
    const message = { ...partial, stopReason: reason };
    detach();
    stream.push(
      reason === "error" || reason === "aborted"
        ? { type: "error", reason, error: message }
        : { type: "done", reason, message },
    );
    stream.end(message);
  };
  const models = new Proxy(base, {
    get(target, key) {
      const value = Reflect.get(target, key, target);
      if (key === "stream" || key === "streamSimple" || key === "streamDeferred")
        return (...args: Parameters<typeof base.streamSimple>) => {
          if (!first) return Reflect.apply(value, target, args);
          first = false;
          const signal = args[2]?.signal,
            abort = () => finish("aborted");
          signal?.addEventListener("abort", abort, { once: true });
          detach = () => signal?.removeEventListener("abort", abort);
          if (signal?.aborted) abort();
          started.resolve();
          return stream;
        };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    models,
    model: faux.getModel(),
    faux,
    started,
    finish,
    push(event: AssistantMessageEvent) {
      if ("partial" in event) partial = event.partial;
      stream.push(event);
    },
  };
}

function scoped(provider: ReturnType<typeof controlledProvider>, runId: string = randomUUID()) {
  const activity = vi.fn(),
    release = vi.fn();
  const router = new ScopedDurableModels(provider.models, async ({ options }) => ({
    model: provider.model,
    options,
    onToolCallProgress: activity,
    release,
  }));
  const reference = router.register(runId, 1, provider.model);
  return {
    router,
    reference,
    model: router.models.getModel(reference.provider, reference.modelId)!,
    activity,
    release,
    runId,
  };
}

it.each(["stream", "streamSimple"] as const)(
  "%s keeps mutable Tool drafts private and preserves text indexes until completion",
  async (method) => {
    const provider = controlledProvider(),
      f = scoped(provider),
      received: AssistantMessageEvent[] = [];
    if (method === "stream")
      f.activity.mockImplementation(() => {
        throw new Error("lost observation");
      });
    const output = f.router.models[method](f.model, { messages: [] });
    const drained = (async () => {
      for await (const event of output) received.push(event);
    })();
    try {
      await provider.started.promise;
      const before = { type: "text" as const, text: "before" },
        partial = fauxAssistantMessage([before], { stopReason: "pending" });
      provider.push({ type: "start", partial });
      await vi.waitFor(() => expect(received).toHaveLength(1));
      const call = fauxToolCall("bash", { command: "UNFINISHED" }, { id: "call-draft" });
      partial.content.push(call);
      provider.push({ type: "toolcall_start", contentIndex: 1, partial });
      provider.push({ type: "toolcall_delta", contentIndex: 1, delta: "UNFINISHED", partial });
      const after = { type: "text" as const, text: "after" };
      partial.content.push(after);
      provider.push({ type: "text_start", contentIndex: 2, partial });
      await vi.waitFor(() => expect(received).toHaveLength(2));
      expect(received[1]).toMatchObject({
        type: "text_start",
        contentIndex: 2,
        partial: { content: [before, { type: "text", text: "" }, after] },
      });
      // Pi providers reuse their partial, mutate blocks and append new blocks.
      before.text = "changed later";
      expect(received[0]).toMatchObject({ partial: { content: [{ text: "before" }] } });
      call.arguments = { command: "printf '完整参数\\n'" };
      provider.push({ type: "toolcall_end", contentIndex: 1, toolCall: call, partial });
      await vi.waitFor(() => expect(f.activity).toHaveBeenCalledTimes(3));
      expect(JSON.stringify(received)).not.toMatch(/toolCall|call-draft|UNFINISHED|printf/);
      expect(f.activity.mock.calls.every((args) => args.length === 0)).toBe(true);
      expect(f.release).not.toHaveBeenCalled();
      provider.finish("toolUse");
      const result = await output.result();
      await drained;
      expect(result.content[1]).toEqual(call);
      expect(received.at(-1)).toMatchObject({ type: "done", message: result });
      expect(f.release).toHaveBeenCalledOnce();
    } finally {
      provider.finish("aborted");
      await drained;
    }
  },
);

it.each(["error", "aborted", "length", "deferred"] as const)(
  "does not retain partial calls through a terminal %s response",
  async (reason) => {
    const provider = controlledProvider(),
      f = scoped(provider),
      output = f.router.models.streamSimple(f.model, { messages: [] });
    await provider.started.promise;
    const partial = fauxAssistantMessage(
      [
        { type: "thinking", thinking: "retained reasoning" },
        fauxToolCall("bash", { command: "INCOMPLETE_ARGUMENT" }),
        { type: "text", text: "retained text" },
      ],
      { stopReason: "pending" },
    );
    provider.push({ type: "text_delta", contentIndex: 2, delta: "retained text", partial });
    provider.finish(reason);
    const result = await output.result();
    const events = [];
    for await (const event of output) events.push(event);
    expect(result.stopReason).toBe(reason);
    expect(result.content).toEqual([
      partial.content[0],
      { type: "text", text: "" },
      partial.content[2],
    ]);
    expect(JSON.stringify(events)).not.toMatch(/toolCall|INCOMPLETE_ARGUMENT/);
    expect(partial.content[1]?.type).toBe("toolCall");
    expect(f.release).toHaveBeenCalledOnce();
  },
);

async function nativeFixture(
  options: {
    journal?: readonly StorageWrite[][];
    runId?: string;
    holdIntent?: boolean;
  } = {},
) {
  const provider = controlledProvider(),
    f = scoped(provider, options.runId),
    journal: StorageWrite[][] = [],
    intent = Promise.withResolvers<void>(),
    acknowledged = Promise.withResolvers<void>();
  const store = new (class extends MemoryStorage {
    override async commit(writes: readonly StorageWrite[]) {
      const prepared = this.prepareCommit(writes);
      journal.push(structuredClone([...prepared.writes]));
      if (
        writes.some(
          (write) =>
            write.type === "task" &&
            write.value.kind === "pi.tool" &&
            "checkpoint" in write.value.state &&
            (write.value.state.checkpoint as { phase?: string })?.phase === "execute",
        )
      ) {
        intent.resolve();
        if (options.holdIntent) await acknowledged.promise;
      }
      return prepared.apply();
    }
  })();
  for (const writes of options.journal ?? []) await store.commit(writes);
  const execute = vi.fn(async (_args: { command: string }) => ({
    content: [{ type: "text" as const, text: "TOOL RESULT" }],
  }));
  const registry = createRegistry();
  registry.install(
    defineExtension({
      name: "publication-probe",
      tools: [
        defineTool({
          name: "bash",
          description: "In-memory contract probe, never a real shell",
          parameters: Type.Object({ command: Type.String() }),
          replay: "unsafe",
          execute,
        }),
      ],
    }),
  );
  const harness = await Harness.open(
    store,
    {
      models: f.router.models,
      registry,
      settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
    },
    context,
  );
  const root = await harness.root(context, { agent: { model: f.reference } });
  return { ...f, provider, store, harness, root, journal, execute, intent, acknowledged };
}

async function streamDraft(f: Awaited<ReturnType<typeof nativeFixture>>) {
  const submission = await f.root.submit(
    { type: "input", content: "test", requestId: "same-input" },
    context,
  );
  await f.provider.started.promise;
  const partial = fauxAssistantMessage(
    [
      { type: "text", text: "VISIBLE STREAM TEXT" },
      fauxToolCall("bash", { command: "INCOMPLETE_ARGUMENT" }, { id: "draft-call" }),
      { type: "text", text: "AFTER TOOL SLOT" },
    ],
    { stopReason: "pending" },
  );
  f.provider.push({
    type: "toolcall_delta",
    contentIndex: 1,
    delta: "INCOMPLETE_ARGUMENT",
    partial,
  });
  f.provider.push({ type: "text_delta", contentIndex: 2, delta: "AFTER TOOL SLOT", partial });
  // Wait for an actual Pi partial commit, not just the adapter's event callback.
  await vi.waitFor(() => expect(JSON.stringify(f.journal)).toContain("VISIBLE STREAM TEXT"));
  expect(JSON.stringify(f.journal)).not.toMatch(/toolCall|draft-call|INCOMPLETE_ARGUMENT/);
  expect(f.execute).not.toHaveBeenCalled();
  return { partial, submission };
}

it("persists text but no Tool draft, then waits for the complete validated intent ACK", async () => {
  const f = await nativeFixture({ holdIntent: true });
  const bodies: PiCloudEventBody[] = [];
  const display = new DurableRunEvents({
    emit: async (body) => {
      bodies.push(body);
    },
    toolId: (id) => id,
    maximumToolOutputBytes: 65536,
    retryAttempts: 1,
    task: (id) => f.harness.getTask(id as TaskId, context),
  });
  const stream = await f.root.watch(context);
  stream.start(async () => {});
  try {
    const { partial, submission } = await streamDraft(f);
    await vi.waitFor(() =>
      expect(JSON.stringify(stream.value.docs["pi.live"])).toContain("AFTER TOOL SLOT"),
    );
    const message = (
      stream.value.docs["pi.live"] as unknown as { generation: { message: AssistantMessage } }
    ).generation.message;
    await display.consume([{ type: "message_start", message }]);
    expect(bodies.filter((body) => body.type === "assistant.text.delta")).toEqual([]);
    const call = partial.content[1]!;
    if (call.type !== "toolCall") throw new Error("Missing controlled Tool call");
    call.arguments = { command: "printf 'COMPLETE_ARGUMENT'" };
    f.provider.push({ type: "toolcall_end", contentIndex: 1, toolCall: call, partial });
    await vi.waitFor(() => expect(f.activity).toHaveBeenCalledTimes(2));
    expect(JSON.stringify(f.journal)).not.toContain("COMPLETE_ARGUMENT");
    f.provider.finish("toolUse");
    await f.intent.promise;
    expect(f.execute).not.toHaveBeenCalled();
    expect(JSON.stringify(f.journal)).toContain("COMPLETE_ARGUMENT");
    f.acknowledged.resolve();
    expect((await submission.wait(context)).status).toBe("done");
    expect(f.execute).toHaveBeenCalledOnce();
    expect(f.execute.mock.calls[0]?.[0]).toEqual(call.arguments);
    expect(JSON.stringify(f.journal)).not.toContain("INCOMPLETE_ARGUMENT");
    const assistant = (await f.root.entries({}, 100, undefined, context)).items.find((entry) =>
      entry.model?.some(
        (message) =>
          message.role === "assistant" &&
          message.content.some((block) => block.type === "toolCall"),
      ),
    );
    if (!assistant) throw new Error("Complete assistant call was not persisted");
    await display.consume([{ type: "message_end", entry: assistant }]);
    expect(bodies.filter((body) => body.type === "assistant.text.delta")).toHaveLength(0);
  } finally {
    f.acknowledged.resolve();
    f.provider.finish("aborted");
    await stream.stop();
    await f.harness.close(context);
  }
});

it("a Tool-only stream writes no draft even when its provider mutates the opening partial", async () => {
  const f = await nativeFixture();
  try {
    const submission = await f.root.submit({ type: "input", content: "test" }, context);
    await f.provider.started.promise;
    const partial = fauxAssistantMessage([], { stopReason: "pending" });
    f.provider.push({ type: "start", partial });
    // Let Durable receive the empty opening snapshot before the provider reuses it.
    await new Promise((resolve) => setTimeout(resolve, 0));
    partial.content.push(fauxToolCall("bash", { command: "TOOL_ONLY_DRAFT" }));
    f.provider.push({ type: "toolcall_delta", contentIndex: 0, delta: "TOOL_ONLY_DRAFT", partial });
    await vi.waitFor(() => expect(f.activity).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(JSON.stringify(f.journal)).not.toMatch(/toolCall|TOOL_ONLY_DRAFT/);
    f.provider.finish("error");
    expect((await submission.wait(context)).status).toBe("unanswered");
    expect(JSON.stringify(f.journal)).not.toMatch(/toolCall|TOOL_ONLY_DRAFT/);
    expect(f.execute).not.toHaveBeenCalled();
  } finally {
    f.provider.finish("aborted");
    await f.harness.close(context);
  }
});

it("Stop during argument generation retains text without a Tool or phantom result", async () => {
  const f = await nativeFixture();
  try {
    const { submission } = await streamDraft(f);
    await f.root.abort(context);
    expect((await submission.wait(context)).status).toBe("unanswered");
    const history = JSON.stringify(await f.root.entries({}, 100, undefined, context));
    expect(history).toContain("VISIBLE STREAM TEXT");
    expect(history).toContain("aborted");
    expect(history).not.toMatch(/toolCall|toolResult|INCOMPLETE_ARGUMENT/);
    expect(JSON.stringify(f.journal)).not.toMatch(/toolCall|INCOMPLETE_ARGUMENT/);
    expect(f.execute).not.toHaveBeenCalled();
  } finally {
    f.provider.finish("aborted");
    await f.harness.close(context);
  }
});

it("reopens a streamed request without replaying drafts or submitting the input twice", async () => {
  const first = await nativeFixture();
  const { submission } = await streamDraft(first);
  // Reopen only the committed prefix from before shutdown, as after process loss.
  const journal = structuredClone(first.journal);
  await first.harness.close(context);
  const second = await nativeFixture({ journal, runId: first.runId });
  try {
    const original = await second.store.submissionByRequest(second.root.id, "same-input", context);
    expect(original?.id).toBe(submission.id);
    second.harness.resume();
    await second.provider.started.promise;
    const reply = fauxAssistantMessage("RECOVERED");
    second.provider.push({ type: "start", partial: reply });
    second.provider.finish("stop");
    await second.root.waitForIdle(context);
    const history = JSON.stringify(await second.root.entries({}, 100, undefined, context));
    expect(history).toContain("RECOVERED");
    expect(history).not.toMatch(/toolCall|toolResult|INCOMPLETE_ARGUMENT/);
    expect(JSON.stringify(second.journal)).not.toMatch(/toolCall|INCOMPLETE_ARGUMENT/);
    expect(first.execute).not.toHaveBeenCalled();
    expect(second.execute).not.toHaveBeenCalled();
    expect(
      (await second.store.submissionByRequest(second.root.id, "same-input", context))?.status,
    ).toBe("done");
  } finally {
    second.provider.finish("aborted");
    await second.harness.close(context);
  }
});
