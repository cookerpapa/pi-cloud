import { expect, it, vi } from "vitest";
import { InMemorySessionStorage, Session } from "@earendil-works/pi-agent-core";
import {
  EventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import type { NativeToolEnd } from "@pi-cloud/protocol";
import { createExecutionReference } from "@pi-cloud/protocol";
import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { NativeSessionWriter } from "../../packages/pi-session-postgres/src/native-session-writer.ts";
import { CloudAgentRuntime } from "../../packages/sandbox-supervisor/src/cloud-agent-runtime.ts";
import { createTrustedRemoteAgentTools } from "../../packages/sandbox-supervisor/src/trusted-remote-tools.ts";
import { WorkerExecutionLog } from "../../packages/runtime-core/src/worker-execution-log.ts";
import { NativeSessionLogPublisher } from "../../packages/runtime-core/src/native-session-log-publisher.ts";
import {
  isNativeAppendFact,
  toolCommandForFact,
} from "../../packages/runtime-core/src/tool-invocation-fact.ts";
import type { AcceptedFact } from "../../packages/runtime-core/src/accepted-fact.ts";
import { toolInvocationFixture } from "../../packages/runtime-core/test/tool-invocation-fixture.ts";

type Call = { id: string; name: string; arguments: Record<string, unknown> };
const write = (id = "call-1"): Call => ({
  id,
  name: "write",
  arguments: { path: "a.txt", content: "hello" },
});
const read = (id: string): Call => ({ id, name: "read", arguments: { path: `${id}.txt` } });

it("keeps both Lanes writable when the real publication path rejects before the bus", async () => {
  const f = toolInvocationFixture();
  const sent: AcceptedFact[] = [];
  const channels = new WorkerExecutionLog(
    {} as Kysely<Database>,
    {
      checkHealth: async () => {},
      append: async (fact) => {
        sent.push(fact);
        return { factId: fact.factId, durable: true };
      },
    },
    { maximumPendingBytes: 3000, maximumPendingFacts: 8 },
  );
  const publisher = new NativeSessionLogPublisher({ channels });
  const metadata = { id: f.scope.piSessionId, createdAt: 1 };
  const fail = vi.fn(async () => {});
  const writer = new NativeSessionWriter({
    id: f.scope.writerId,
    metadata,
    nextSequence: 1,
    lanes: [
      { lane: "main", leafId: null },
      { lane: "child", leafId: null },
    ],
    hasId: async () => false,
    waitProjected: async () => {},
    fail,
  });
  const open = async (lane: string) => {
    const runId = crypto.randomUUID(),
      turnId = crypto.randomUUID();
    const scope = { ...f.scope, piSessionLane: lane, runId, turnId };
    const executionReference = createExecutionReference(scope.leaseId, runId, scope.fencingToken);
    await channels.open({
      executionReference,
      sessionId: scope.sessionId,
      turnId,
      nextEventSeq: 1,
      piSession: { id: scope.piSessionId, lane, writerId: scope.writerId },
      publication: { scope },
    });
    return writer.open(
      { lane, runId, turnId },
      { reader: new InMemorySessionStorage(metadata), branch: [], openOperations: [] },
      publisher.scoped({ ...scope, executionReference }),
    );
  };
  const main = await open("main"),
    child = await open("child");
  const rejectedId = writer.idGenerator();
  await expect(
    main.appendEntry(
      { id: rejectedId, type: "custom", customType: "test", data: { text: "x".repeat(10000) } },
      "main",
    ),
  ).rejects.toMatchObject({ code: "event_capacity_exhausted" });
  expect(sent).toHaveLength(0);
  expect(writer.failed).toBe(false);
  expect(
    await child.appendEntry(
      { id: writer.idGenerator(), type: "custom", customType: "test" },
      "child",
    ),
  ).toMatchObject({ seq: 1 });
  expect(
    await main.appendEntry({ id: rejectedId, type: "custom", customType: "test" }, "main"),
  ).toMatchObject({ seq: 2, parentId: null });
  expect(sent).toHaveLength(2);
  expect(fail).not.toHaveBeenCalled();
});

async function fixture(
  options: {
    calls?: Call[][];
    blocked?: boolean;
    prepare?: () => Promise<void>;
    beforePublish?: () => void;
    invocationAck?: (fact: AcceptedFact) => Promise<void>;
    assistantAck?: () => Promise<void>;
    reply?: "immediate" | "manual";
  } = {},
) {
  const f = toolInvocationFixture();
  const metadata = { id: f.scope.piSessionId, createdAt: 1 };
  const reader = new InMemorySessionStorage(metadata);
  const facts: AcceptedFact[] = [];
  const replies = new Map<
    string,
    { resolve(event: NativeToolEnd): void; signal: AbortSignal; request: any }
  >();
  const accepted = Promise.withResolvers<void>();
  const assistantAccepted = Promise.withResolvers<void>();
  const coldApply = async (fact: AcceptedFact) => {
    if (!isNativeAppendFact(fact)) return;
    for (const item of fact.items) {
      if (item.kind === "entry") {
        const { seq: _s, timestamp: _t, parentId: _p, ...entry } = item.entry;
        await reader.appendEntry(entry as any, item.lane);
      } else if (item.kind === "record") {
        const { seq: _s, timestamp: _t, ...record } = item.record;
        await reader.appendRecord(record);
      }
    }
  };
  const resolveReply = (operationId: string) => {
    const reply = replies.get(operationId)!;
    reply.resolve({
      type: "tool_execution_end",
      toolCallId: reply.request.toolCallId,
      toolName: reply.request.toolName,
      isError: false,
      result: { content: [{ type: "text", text: "raw guest result" }], details: {} },
    });
  };
  const bus = {
    checkHealth: async () => {},
    append: vi.fn(async (fact: AcceptedFact) => {
      facts.push(structuredClone(fact));
      await coldApply(fact);
      if (
        isNativeAppendFact(fact) &&
        fact.items.some(
          (item) =>
            item.kind === "entry" &&
            item.entry.type === "message" &&
            item.entry.message.role === "assistant" &&
            item.entry.message.stopReason === "toolUse",
        )
      ) {
        assistantAccepted.resolve();
        await options.assistantAck?.();
      }
      if (fact.kind === "tool_invocation") {
        const command = toolCommandForFact(fact)!;
        expect(replies.has(command.request.operationId)).toBe(true);
        if (options.reply !== "manual") resolveReply(command.request.operationId);
        accepted.resolve();
        await options.invocationAck?.(fact);
      }
      return { factId: fact.factId, durable: true as const };
    }),
  };
  const log = new WorkerExecutionLog({} as Kysely<Database>, bus);
  await log.open({
    publication: { scope: f.scope },
    executionReference: f.executionReference,
    sessionId: f.scope.sessionId,
    turnId: f.scope.turnId,
    nextEventSeq: 1,
    piSession: { id: f.scope.piSessionId, lane: "main", writerId: f.scope.writerId },
  });
  const publisher = new NativeSessionLogPublisher({ channels: log, toolReplyTopic: "reply-boot" });
  const fail = vi.fn(async () => {});
  const writer = new NativeSessionWriter({
    id: f.scope.writerId,
    metadata,
    nextSequence: 1,
    lanes: [{ lane: "main", leafId: null }],
    hasId: async () => false,
    waitProjected: async () => {},
    fail,
  });
  const storage = await writer.open(
    { lane: "main", turnId: f.scope.turnId, runId: f.scope.runId },
    { reader, branch: [], openOperations: [] },
    publisher.scoped(f.mutation.scope),
  );
  const standalone = vi.fn(async () => {
    throw new Error("fixed Tool used standalone publication");
  });
  const prepare = vi.fn(async () => {
    await options.prepare?.();
    return { workflowUrl: "http://broker/workflow", activationId: f.command.request.activationId };
  });
  let step = 0;
  const remote = createTrustedRemoteAgentTools({
    publishToolCommand: standalone,
    waitForToolReply: (request, signal) =>
      new Promise<NativeToolEnd>((resolve, reject) => {
        replies.set(request.operationId, { resolve, signal, request });
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        options.beforePublish?.();
      }),
    resolveOperationTarget: prepare,
    executionReference: f.executionReference,
    turnContextSha256: "a".repeat(64),
    executionContextSha256: "b".repeat(64),
    remainingToolCalls: 16,
    maximumToolOutputBytes: 65536,
    workingDirectory: "/workspace",
    captureStepContext: (activeTools) => ({
      samplingAttempt: 1,
      modelMessages: [],
      step: {
        sha256: "c".repeat(64),
        context: {
          schemaVersion: 2,
          sequence: ++step,
          turnContextSha256: "a".repeat(64),
          executionContextSha256: "b".repeat(64),
          activeTools: [...activeTools],
          worldState: {
            sandbox: { status: "inactive", continuitySha256: null },
            environmentSha256: "d".repeat(64),
            workspaceBindingSha256: "e".repeat(64),
            toolPolicySha256: "f".repeat(64),
          },
        },
      },
    }),
  });
  let sample = 0;
  const batches = options.calls ?? [[write()]];
  const runtime = new CloudAgentRuntime({
    session: storage.asSession(),
    lane: "main",
    idGenerator: writer.idGenerator,
    authority: {
      signal: writer.signal,
      assertCurrent: async () => writer.signal.throwIfAborted(),
      close: async () => {},
    },
    model: getModel("openai", "gpt-4o-mini"),
    systemPrompt: "test",
    tools: remote.tools,
    transformContext: (messages) => remote.transformContext(messages),
    ...(options.blocked
      ? { beforeToolCall: async () => ({ block: true, reason: "blocked" }) }
      : {}),
    afterToolCall: async () => ({ content: [{ type: "text", text: "canonical after hook" }] }),
    compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
    commitCheckpoint: async (operation, _event, publication) => {
      await storage.mutationPort().mutate(operation, [], publication);
    },
    streamFn: () => {
      const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
        (e) => e.type === "done" || e.type === "error",
        (e) => (e.type === "done" ? e.message : (e as any).error),
      );
      const calls = batches[sample++];
      const message: AssistantMessage = {
        role: "assistant",
        api: "openai-responses",
        provider: "openai",
        model: "gpt-4o-mini",
        timestamp: Date.now(),
        stopReason: calls ? "toolUse" : "stop",
        content: calls
          ? calls.map((c) => ({ type: "toolCall" as const, ...c }))
          : [{ type: "text", text: "done" }],
        usage: {
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      };
      queueMicrotask(() =>
        stream.push({ type: "done", reason: calls ? "toolUse" : "stop", message }),
      );
      return stream;
    },
  });
  const items = () => facts.flatMap((fact) => (isNativeAppendFact(fact) ? fact.items : []));
  return {
    runtime,
    facts,
    items,
    reader,
    writer,
    fail,
    accepted,
    assistantAccepted,
    prepare,
    standalone,
    replies,
    resolveReply,
  };
}

it("keeps the Assistant checkpoint, publishes one invocation, and canonicalizes the after-hook result", async () => {
  const f = await fixture();
  expect(await f.runtime.run("write it")).toMatchObject({ kind: "completed" });
  expect(f.facts.filter((fact) => fact.kind === "tool_invocation")).toHaveLength(1);
  const invocation = f.facts.findIndex((fact) => fact.kind === "tool_invocation");
  expect(
    f.facts
      .slice(0, invocation)
      .some(
        (fact) =>
          isNativeAppendFact(fact) &&
          fact.items.some(
            (item) =>
              item.kind === "entry" &&
              item.entry.type === "message" &&
              item.entry.message.role === "assistant",
          ),
      ),
  ).toBe(true);
  expect(
    f.items().filter((item) => item.kind === "record" && item.record.type === "tool_started"),
  ).toHaveLength(1);
  const result = f
    .items()
    .find(
      (item) =>
        item.kind === "entry" &&
        item.entry.type === "message" &&
        item.entry.message.role === "toolResult",
    );
  expect(result).toMatchObject({
    entry: { message: { content: [{ text: "canonical after hook" }] } },
  });
  expect(f.standalone).not.toHaveBeenCalled();
  expect([...f.replies.values()].every((reply) => reply.signal.aborted)).toBe(true);
});

it.each(["invalid", "blocked", "preparation"])(
  "does not admit a Tool after %s rejection",
  async (failure) => {
    const f = await fixture({
      calls: [[failure === "invalid" ? { ...write(), arguments: { path: "a" } } : write()]],
      blocked: failure === "blocked",
      ...(failure === "preparation"
        ? {
            prepare: async () => {
              throw new Error("Cube unavailable");
            },
          }
        : {}),
    });
    expect(await f.runtime.run("write it")).toMatchObject({ kind: "completed" });
    expect(f.facts.some((fact) => fact.kind === "tool_invocation")).toBe(false);
    expect(
      f.items().some((item) => item.kind === "record" && item.record.type === "tool_started"),
    ).toBe(false);
    if (failure !== "preparation") expect(f.prepare).not.toHaveBeenCalled();
    expect(f.standalone).not.toHaveBeenCalled();
  },
);

it("waits for the complete Assistant ACK before preparing a remote invocation", async () => {
  const ack = Promise.withResolvers<void>();
  const f = await fixture({ assistantAck: () => ack.promise });
  const pending = f.runtime.run("write it");
  await f.assistantAccepted.promise;
  expect(f.prepare).not.toHaveBeenCalled();
  expect(f.replies.size).toBe(0);
  ack.resolve();
  expect(await pending).toMatchObject({ kind: "completed" });
  expect(f.prepare).toHaveBeenCalledOnce();
});

it("retires a prepared reply callback when cancelled before publication", async () => {
  let runtime: CloudAgentRuntime;
  const f = await fixture({ beforePublish: () => runtime.abort() });
  runtime = f.runtime;
  expect(await runtime.run("write it")).toMatchObject({ kind: "aborted" });
  expect(f.facts.some((fact) => fact.kind === "tool_invocation")).toBe(false);
  expect(f.replies.size).toBe(1);
  expect([...f.replies.values()].every((reply) => reply.signal.aborted)).toBe(true);
});

it.each(["cancel", "lost_ack", "success"])(
  "handles an early reply with %s at the single ACK boundary",
  async (outcome) => {
    const ack = Promise.withResolvers<void>();
    const f = await fixture({ invocationAck: () => ack.promise });
    const running = f.runtime.run("write it");
    await f.accepted.promise;
    expect(
      f
        .items()
        .some(
          (item) =>
            item.kind === "entry" &&
            item.entry.type === "message" &&
            item.entry.message.role === "toolResult",
        ),
    ).toBe(false);
    if (outcome === "cancel") f.runtime.abort();
    if (outcome === "lost_ack") ack.reject(new Error("lost acknowledgement"));
    else ack.resolve();
    if (outcome === "lost_ack") await expect(running).rejects.toThrow("writer requires recovery");
    else expect((await running).kind).toBe(outcome === "success" ? "completed" : "aborted");
    expect(f.facts.filter((fact) => fact.kind === "tool_invocation")).toHaveLength(1);
    expect(f.writer.failed).toBe(outcome === "lost_ack");
    expect([...f.replies.values()].every((reply) => reply.signal.aborted)).toBe(true);
    expect(f.standalone).not.toHaveBeenCalled();
    if (outcome === "lost_ack") {
      let resumedContext = "";
      const resumed = new CloudAgentRuntime({
        session: new Session(f.reader),
        lane: "main",
        authority: {
          signal: new AbortController().signal,
          assertCurrent: async () => {},
          close: async () => {},
        },
        model: getModel("openai", "gpt-4o-mini"),
        systemPrompt: "test",
        compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
        streamFn: (_model, context) => {
          resumedContext = JSON.stringify(context.messages);
          const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
            (event) => event.type === "done",
            (event) => (event as any).message,
          );
          const message: AssistantMessage = {
            role: "assistant",
            api: "openai-responses",
            provider: "openai",
            model: "gpt-4o-mini",
            timestamp: Date.now(),
            stopReason: "stop",
            content: [{ type: "text", text: "inspect the environment" }],
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              totalTokens: 2,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
          };
          queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
          return stream;
        },
      });
      expect(await resumed.run("continue")).toMatchObject({ kind: "completed" });
      expect(
        JSON.parse(resumedContext).find((message: any) => message.role === "toolResult"),
      ).toMatchObject({
        toolCallId: "call-1",
        isError: true,
        details: { kind: "pi-cloud.unknown_tool_effect" },
      });
      expect(f.facts.filter((fact) => fact.kind === "tool_invocation")).toHaveLength(1);
    }
  },
);

it("admits sequential Tools separately and leaves later calls unstarted on cancellation", async () => {
  const f = await fixture({ calls: [[write("first"), write("second")]], reply: "manual" });
  const pending = f.runtime.run("write both");
  await f.accepted.promise;
  f.runtime.abort();
  expect(await pending).toMatchObject({ kind: "aborted" });
  const admitted = f.facts.filter((fact) => fact.kind === "tool_invocation");
  expect(admitted).toHaveLength(1);
  expect(toolCommandForFact(admitted[0]!)!.request).toMatchObject({ toolCallId: "first" });
});

it("preserves parallel reads and gives reused provider IDs distinct invocation identities", async () => {
  const f = await fixture({
    calls: [[read("same"), read("other")], [read("same")]],
    reply: "manual",
  });
  const pending = f.runtime.run("read them");
  await vi.waitFor(() => expect(f.replies.size).toBe(2));
  for (const id of f.replies.keys()) f.resolveReply(id);
  await vi.waitFor(() => expect(f.replies.size).toBe(3));
  f.resolveReply([...f.replies.keys()][2]!);
  expect(await pending).toMatchObject({ kind: "completed" });
  const commands = f.facts.flatMap((fact) =>
    fact.kind === "tool_invocation" ? [toolCommandForFact(fact)!] : [],
  );
  expect(new Set(commands.map((command) => command.toolCallId)).size).toBe(3);
  expect(new Set(commands.map((command) => command.request.operationId)).size).toBe(3);
  expect(f.standalone).not.toHaveBeenCalled();
});
