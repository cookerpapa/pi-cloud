// Public native Harness contracts with an acknowledged in-memory transport fixture.
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import {
  MemoryStorage,
  StorageRejected,
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
  MAX_SUBAGENT_RESULT_BYTES,
  SUBAGENT_RESULT_TOO_LARGE,
  type DurableSessionCommit,
} from "@pi-cloud/protocol";
import { ToolReplyMailbox, parseWorkerReply } from "@pi-cloud/event-log";
import { DurableAgentSession } from "../src/durable/agent-session.ts";
import type { CloudModelRequest } from "../src/durable/scoped-models.ts";
import { DurableRunEvents } from "../src/durable/run-events.ts";
import { supervisorToolResult } from "../../control-plane/src/control-tool-results.ts";
import { restoreToolReply } from "../../supervisor-host/src/tool-reply-result.ts";

async function fixture(
  result: ToolExecutionResult,
  options: { name?: string; hold?: boolean; rejectResultOnce?: boolean } = {},
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
    executions = 0,
    rejectedResult = false;
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
        if (options.rejectResultOnce && !rejectedResult) {
          rejectedResult = true;
          throw new StorageRejected("Definite result publication refusal");
        }
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
      invocation: import("../src/durable/remote-tools.ts").RemoteInvocation,
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

it("settles a rejected result as a native task fault without replaying the Tool", async () => {
  const f = await fixture(
    { content: [{ type: "text", text: "UNCOMMITTED SUCCESS" }] },
    { rejectResultOnce: true },
  );
  try {
    expect((await f.submission.wait(context)).status).toBe("done");
    expect(f.executions()).toBe(1);
    expect(f.provider.state.callCount).toBe(2);
    const view = await f.conversation.context(context);
    const result = view.messages.find((message) => message.role === "toolResult");
    expect(result).toMatchObject({ isError: true, details: { reason: "missing_result" } });
    expect(JSON.stringify(view.messages)).not.toContain("UNCOMMITTED SUCCESS");
    expect(
      f.journal
        .flat()
        .some(
          (write) =>
            write.type === "task" &&
            write.value.kind === "pi.tool" &&
            write.value.state.status === "terminal" &&
            write.value.state.outcome.status === "faulted",
        ),
    ).toBe(true);
  } finally {
    await f.watch.stop();
    await f.runtime.close();
  }
});

it.each(["json", "escaped", "multiline"])(
  "preserves a control result at the native %s boundary",
  async (mode) => {
    const value = { executionId: "child", output: "END_OF_CHILD_RESULT" };
    const jsonOverhead = Buffer.byteLength(JSON.stringify(value));
    const text =
      mode === "json"
        ? serializeSubagentResult({
            ...value,
            output: "x".repeat(MAX_SUBAGENT_RESULT_BYTES - jsonOverhead) + value.output,
          })
        : mode === "escaped"
          ? serializeSubagentResult("\u0000".repeat(MAX_SUBAGENT_RESULT_BYTES))
          : serializeSubagentResult(
              Array.from({ length: 1999 }, (_, i) => `item-${i}\n`).join("") + "FINAL_DECISION\n",
            );
    const result = supervisorToolResult("supervisor", { output: text, executionId: "child" });
    const f = await fixture(result as ToolExecutionResult, { name: "subagent_supervisor" });
    try {
      expect((await f.submission.wait(context)).status).toBe("done");
      const message = (await f.conversation.context(context)).messages.find(
        (m) => m.role === "toolResult",
      )!;
      if (message.role !== "toolResult") throw Error("Missing result");
      expect(message.content).toEqual([{ type: "text", text }]);
      expect(message.isError).toBe(false);
      expect(message.details).toEqual({ executionId: "child" });
      if (mode === "json")
        expect(JSON.parse(text).output.endsWith("END_OF_CHILD_RESULT")).toBe(true);
      const terminal = f.journal.find((writes) =>
        writes.some((w) => w.type === "entry" && w.value.kind === "pi.tool-result"),
      )!;
      expect(Buffer.byteLength(JSON.stringify(terminal))).toBeLessThan(900 * 1024);
    } finally {
      f.ack.resolve();
      await f.watch.stop();
      await f.runtime.close();
    }
  },
);

it.each(["x".repeat(MAX_SUBAGENT_RESULT_BYTES + 1), "line\n".repeat(2001)])(
  "settles an oversized coordination return as an error without truncating success",
  async (text) => {
    let error: Error | undefined;
    try {
      supervisorToolResult("supervisor", { output: text });
    } catch (cause) {
      error = cause as Error;
    }
    expect(error?.message).toBe(SUBAGENT_RESULT_TOO_LARGE);
    const f = await fixture({ content: [{ type: "text", text: error!.message }], isError: true });
    try {
      expect((await f.submission.wait(context)).status).toBe("done");
      const message = (await f.conversation.context(context)).messages.find(
        (m) => m.role === "toolResult",
      )!;
      expect(message).toMatchObject({
        isError: true,
        content: [{ type: "text", text: SUBAGENT_RESULT_TOO_LARGE }],
      });
      expect(f.executions()).toBe(1);
      expect(f.provider.state.callCount).toBe(2);
    } finally {
      await f.watch.stop();
      await f.runtime.close();
    }
  },
);

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
        openModel: async (r: CloudModelRequest) => ({
          model: provider.getModel(),
          options: r.options,
          release() {},
        }),
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
    } finally {
      await next.close();
    }
  }
});

it.each([null, { type: "text", text: 17 }, { type: "unexpected" }])(
  "rejects malformed final parts before known settlement: %j",
  async (part) => {
    const raw = {
      toolCallId: "call",
      toolName: "bash",
      result: { content: [part] },
      isError: false,
    };
    const frame = { kind: "tool_result", operationId: "op", sequence: 1, result: raw };
    expect(() => parseToolResultPayload(raw)).toThrow();
    expect(() => parseWorkerReply(JSON.stringify(frame))).toThrow();
    const mailbox = new ToolReplyMailbox();
    const waiting = mailbox.wait("op", "call", "bash", new AbortController().signal);
    const restored = restoreToolReply(
      waiting,
      undefined,
      { tenantId: "fixture" },
      new AbortController().signal,
    );
    mailbox.accept(frame as never);
    expect(waiting.executionSettled()).toBe(false);
    await expect(restored.result).rejects.toMatchObject({
      code: "tool_reply_protocol_error",
      effect: "unknown",
    });
    expect(mailbox.size).toBe(0);
  },
);
