// Review characterizations, not repair regressions. No production IO or model calls.
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { afterAll, expect, it } from "vitest";
import {
  MemoryStorage,
  type Seq,
  type StorageWrite,
  type ToolExecutionResult,
} from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import type { Context } from "@earendil-works/chord";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxProvider,
  fauxAssistantMessage,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  controlToolDefinitions,
  serializeSubagentResult,
  parseToolResultPayload,
  createPiCloudEventFactory,
  resolveDurableDisplay,
  type DurableSessionCommit,
} from "@pi-cloud/protocol";
import { ToolReplyMailbox, parseWorkerReply } from "@pi-cloud/event-log";
import { DurableAgentSession } from "../../../packages/sandbox-supervisor/src/durable/agent-session.ts";
import { prepareToolPresentation } from "../../../packages/sandbox-supervisor/src/durable/tool-presentation.ts";
import { DurableRunEvents } from "../../../packages/sandbox-supervisor/src/durable/run-events.ts";
import { supervisorToolResult } from "../../../packages/control-plane/src/control-tool-results.ts";
import { restoreToolReply } from "../../../packages/supervisor-host/src/tool-reply-result.ts";

const observations: Record<string, unknown> = {};
afterAll(async () => {
  await writeFile(
    new URL("settlement-evidence.json", import.meta.url),
    JSON.stringify(observations, null, 2) + "\n",
  );
});

async function fixture(
  result: ToolExecutionResult,
  options: { name?: string; hold?: boolean } = {},
) {
  const name = options.name ?? "subagent";
  const definition = controlToolDefinitions().find((tool) => tool.name === name)!;
  const args =
    name === "subagent" ? { action: "status", target: "owned-child" } : { action: "pending" };
  const models = createModels(),
    provider = fauxProvider({ tokensPerSecond: 1_000_000 });
  models.setProvider(provider.provider);
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
    fauxAssistantMessage("DONE"),
  ]);
  let runtime: DurableAgentSession | undefined,
    executions = 0;
  const journal: StorageWrite[][] = [],
    resultPrepared = Promise.withResolvers<StorageWrite[]>(),
    ack = Promise.withResolvers<void>();
  const events: import("@earendil-works/pi-durable").AgentEvent[] = [];
  const store = new (class extends MemoryStorage {
    override async commit(writes: readonly StorageWrite[], _context: Context): Promise<Seq> {
      const prepared = this.prepareCommit(writes);
      const effects = runtime?.preparePublication({
        seq: prepared.seq,
        nextId: 10000,
        writes: prepared.writes,
      } as unknown as DurableSessionCommit);
      if (writes.some((w) => w.type === "entry" && w.value.kind === "pi.tool-result")) {
        resultPrepared.resolve(structuredClone([...writes]));
        if (options.hold) await ack.promise;
      }
      const seq = prepared.apply();
      journal.push(structuredClone([...writes]));
      effects?.confirmed();
      return seq;
    }
  })();
  runtime = await DurableAgentSession.open(store, {
    models,
    remoteTools: [definition],
    settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
  });
  const runId = randomUUID();
  const binding = {
    runId,
    conversationId: 1,
    model: provider.getModel(),
    agent: {},
    context: {},
    remoteTools: [name],
    tools: [],
    assertCurrent: async () => {},
    openModel: async ({ options }: { options: object }) => ({
      model: provider.getModel(),
      options,
      release() {},
    }),
    prepareRemote: async (
      invocation: import("../../../packages/sandbox-supervisor/src/durable/remote-tools.ts").RemoteInvocation,
    ) => ({
      command: {
        target: "control" as const,
        executionReference: "fixture",
        operationId: randomUUID(),
        toolCallId: `task:${invocation.taskId}`,
        nativeCallId: invocation.callId,
        conversationId: invocation.conversationId,
        toolName: name,
        arguments: invocation.args,
        contextAnchor: null,
        occurredAt: new Date().toISOString(),
      },
      completed: () => true,
      dispose() {},
      result: async () => {
        executions++;
        return result;
      },
    }),
  };
  const conversation = await runtime.bind(binding as never);
  const watch = await runtime.watch(conversation.id, async (batch) => {
    events.push(...batch);
  });
  const submission = await conversation.submit(
    { type: "input", content: "Run the Tool", requestId: "owned-input" },
    context,
  );
  return {
    runtime,
    store,
    provider,
    definition,
    binding,
    conversation,
    submission,
    journal,
    resultPrepared,
    ack,
    events,
    executions: () => executions,
    watch,
  };
}

it("characterizes accepted Subagent JSON being cut by the default native byte limit", async () => {
  const text = serializeSubagentResult({
    executionId: "child",
    state: "completed",
    output: "x".repeat(80 * 1024) + "END_OF_CHILD_RESULT",
  });
  const f = await fixture({ content: [{ type: "text", text }], isError: false });
  try {
    expect((await f.submission.wait(context)).status).toBe("done");
    const message = (await f.conversation.context(context)).messages.find(
      (m) => m.role === "toolResult",
    )!;
    expect(message.role).toBe("toolResult");
    if (message.role !== "toolResult") throw Error("missing result");
    const part = message.content[0];
    if (part.type !== "text") throw Error("missing text");
    expect(Buffer.byteLength(part.text)).toBe(51200);
    expect(() => JSON.parse(part.text)).toThrow();
    expect(message.isError).toBe(false);
    expect(part.text).not.toContain("END_OF_CHILD_RESULT");
    observations.byteLimit = {
      acceptedBytes: Buffer.byteLength(text),
      storedFirstPartBytes: Buffer.byteLength(part.text),
      invalidJson: true,
      isError: message.isError,
      calls: f.executions(),
    };
  } finally {
    f.ack.resolve();
    await f.watch.stop();
    await f.runtime.close();
  }
});

it("characterizes a small multiline supervisor reply being cut at 2000 lines", async () => {
  const text = Array.from({ length: 2200 }, (_, i) => `item-${i}`).join("\n") + "\nFINAL_DECISION";
  const result = supervisorToolResult("supervisor", { output: text });
  const f = await fixture(result, { name: "subagent_supervisor" });
  try {
    expect((await f.submission.wait(context)).status).toBe("done");
    const message = (await f.conversation.context(context)).messages.find(
      (m) => m.role === "toolResult",
    )!;
    if (message.role !== "toolResult" || message.content[0].type !== "text")
      throw Error("missing result");
    const output = message.content[0].text;
    expect(output).not.toContain("FINAL_DECISION");
    expect(output.trimEnd().split("\n")).toHaveLength(2000);
    observations.lineLimit = {
      acceptedBytes: Buffer.byteLength(text),
      acceptedLines: 2201,
      retainedLines: output.trimEnd().split("\n").length,
      completeDetailsStillRetained: JSON.stringify(message.details).includes("FINAL_DECISION"),
    };
  } finally {
    f.ack.resolve();
    await f.watch.stop();
    await f.runtime.close();
  }
});

it("keeps final result, task end and live end behind one native ACK; neither recovery prefix reexecutes", async () => {
  const f = await fixture(
    { content: [{ type: "text", text: "COMPLETED_EFFECT" }] },
    { hold: true },
  );
  let before: StorageWrite[][], after: StorageWrite[][];
  try {
    const batch = await f.resultPrepared.promise;
    before = structuredClone(f.journal);
    expect(JSON.stringify(before)).not.toContain("COMPLETED_EFFECT");
    expect(f.provider.state.callCount).toBe(1);
    const entry = batch.find((w) => w.type === "entry" && w.value.kind === "pi.tool-result")!;
    const terminal = batch.find(
      (w) => w.type === "task" && w.value.kind === "pi.tool" && w.value.state.status === "terminal",
    )!;
    expect(entry).toBeDefined();
    expect(terminal).toBeDefined();
    expect(batch.some((w) => w.type === "document.change")).toBe(true);
    f.ack.resolve();
    expect((await f.submission.wait(context)).status).toBe("done");
    const at = f.journal.findIndex((writes) =>
      writes.some((w) => w.type === "entry" && w.value.kind === "pi.tool-result"),
    );
    after = structuredClone(f.journal.slice(0, at + 1));
    observations.atomicSettlement = {
      oneBatch: true,
      noNextModelBeforeAck: true,
      originalExecutions: f.executions(),
    };
    await new Promise((r) => setTimeout(r, 0));
    const toolEvents = f.events.filter(
      (e) =>
        (e.type === "message_end" || e.type === "tool_execution_end") &&
        e.entry?.kind === "pi.tool-result",
    );
    const generated: unknown[] = [];
    const display = new DurableRunEvents({
      emit: async (b) => {
        generated.push(b);
      },
      retryAttempts: 0,
      task: async () => undefined,
    });
    await display.consume(toolEvents);
    expect(toolEvents).toHaveLength(2);
    expect(generated).toHaveLength(0);
    observations.observer = {
      nativeToolEntryEvents: toolEvents.map((e) => e.type),
      displayBodies: generated.length,
      currentRunnerEntryLookups: toolEvents.length,
    };
  } finally {
    f.ack.resolve();
    await f.watch.stop();
    await f.runtime.close();
  }
  for (const [label, journal] of [
    ["before", before!],
    ["after", after!],
  ] as const) {
    const store = new MemoryStorage();
    for (const writes of journal) await store.commit(writes, context);
    const models = createModels(),
      provider = fauxProvider({ tokensPerSecond: 1_000_000 });
    models.setProvider(provider.provider);
    provider.setResponses([fauxAssistantMessage("RECOVERED")]);
    let replayed = 0;
    const next = await DurableAgentSession.open(store, {
      models,
      remoteTools: [f.definition],
      settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
    });
    try {
      const conversation = await next.bind({
        ...f.binding,
        model: provider.getModel(),
        openModel: async (r) => ({ model: provider.getModel(), options: r.options, release() {} }),
        prepareRemote: async () => {
          replayed++;
          throw Error("Unsafe replay");
        },
      } as never);
      await conversation.waitForIdle(context);
      const messages = (await conversation.context(context)).messages;
      expect(replayed).toBe(0);
      expect(JSON.stringify(messages).includes("COMPLETED_EFFECT")).toBe(label === "after");
      if (label === "before")
        expect(JSON.stringify(messages)).toContain("interrupted and may have partially run");
      observations[`recovery_${label}`] = { replayed, originalResultPreserved: label === "after" };
    } finally {
      await next.close();
    }
  }
});

it.each([null, { type: "text", text: 17 }, { type: "unexpected" }])(
  "characterizes malformed content accepted as known settlement: %j",
  async (part) => {
    const raw = {
      toolCallId: "call",
      toolName: "bash",
      result: { content: [part] },
      isError: false,
    };
    expect(() => parseToolResultPayload(raw)).not.toThrow();
    const mailbox = new ToolReplyMailbox();
    const waiting = mailbox.wait("op", "call", "bash", new AbortController().signal);
    const restored = restoreToolReply(
      waiting,
      undefined,
      { tenantId: "fixture" },
      new AbortController().signal,
    );
    mailbox.accept(
      parseWorkerReply(
        JSON.stringify({ kind: "tool_result", operationId: "op", sequence: 1, result: raw }),
      ),
    );
    expect(waiting.executionSettled()).toBe(true);
    const reply = await restored.result;
    const commit = {
      seq: 1,
      nextId: 100,
      writes: [
        {
          type: "entry",
          value: {
            id: 5,
            conversationId: 1,
            kind: "pi.tool-result",
            model: [
              {
                role: "toolResult",
                toolCallId: "call",
                toolName: "bash",
                content: reply.result.content,
                isError: false,
                timestamp: 1,
              },
            ],
          },
        },
      ],
    } as unknown as DurableSessionCommit;
    expect(() => {
      const views = prepareToolPresentation(
        commit,
        [],
        createPiCloudEventFactory({ sessionId: "session", turnId: "turn", agentId: "agent" }),
        { conversationId: 1, maximumOutputBytes: 65536 },
      );
      for (const view of views) resolveDurableDisplay(commit, view, () => undefined);
    }).toThrow();
    observations[`malformed_${part === null ? "null" : part.type}`] = {
      mailboxAccepted: true,
      executionSettled: true,
      imageRestorationAccepted: true,
      laterPresentationRejected: true,
    };
  },
);
