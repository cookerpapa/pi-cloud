import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import type {
  AssistantMessage,
  AssistantMessageEvent,
  Context,
  Models,
} from "@earendil-works/pi-ai";
import { EventStream } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import type {
  AgentMessage,
  CustomEntryContextMessageProjector,
} from "@earendil-works/pi-agent-core";
import type { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  CloudAgentRuntime,
  PostgresPiSessionStorage,
  type CloudAgentExecutionAuthority,
  type CloudAgentRuntimeEvent,
  type PiSessionMutationOperation,
} from "../src/index.ts";

const TENANT_ID = "d2000000-0000-4000-8000-000000000001";

let pglite: PGlite;
let socketServer: PGLiteSocketServer;
let database: Kysely<Database>;

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done") return event.message;
        if (event.type === "error") return event.error;
        throw new Error("Unexpected mock model event");
      },
    );
  }
}

function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "openai-responses",
    provider: "openai",
    model: "gpt-4o-mini",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

function assistantError(message: string): AssistantMessage {
  return {
    ...assistant(""),
    stopReason: "error",
    errorMessage: message,
  };
}

class TestAuthority implements CloudAgentExecutionAuthority {
  readonly #abort = new AbortController();
  current = true;
  closed = false;

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  async assertCurrent(): Promise<void> {
    if (!this.current) throw new Error("stale test authority");
  }

  revoke(): void {
    this.current = false;
    this.#abort.abort(new Error("stale test authority"));
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function scriptedStream(messages: string[], contexts: Context[] = []) {
  let index = 0;
  return (_model: unknown, context: Context) => {
    contexts.push(structuredClone(context));
    const stream = new MockAssistantStream();
    queueMicrotask(() => {
      const message = assistant(messages[index++] ?? `answer-${index}`);
      stream.push({ type: "done", reason: "stop", message });
    });
    return stream;
  };
}

async function createStorage() {
  return PostgresPiSessionStorage.create({
    database,
    tenantId: TENANT_ID,
    sessionId: globalThis.crypto.randomUUID(),
  });
}

beforeAll(async () => {
  pglite = await PGlite.create();
  socketServer = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
  await socketServer.start();
  database = createDatabase({
    connectionString: `postgresql://postgres@${socketServer.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 1,
  });
  await runMigrations(database, "up");
  await database
    .insertInto("tenants")
    .values({ id: TENANT_ID, slug: "cloud-agent-runtime" })
    .execute();
}, 30_000);

afterAll(async () => {
  await database?.destroy();
  await socketServer?.stop();
  await pglite?.close();
});

describe.sequential("CloudAgentRuntime", () => {
  it("keeps frozen Cloud stream options while preserving the active call signal", async () => {
    const storage = await createStorage();
    const hostedPayload = (payload: unknown) => payload;
    let observedOptions: Record<string, unknown> | undefined;
    const runtime = new CloudAgentRuntime({
      lane: "main",
      session: storage.asSession(),
      authority: new TestAuthority(),
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      streamOptions: {
        transport: "sse",
        onPayload: hostedPayload,
        maxRetries: 0,
      },
      streamFn: (_model, _context, options) => {
        observedOptions = options as unknown as Record<string, unknown>;
        const stream = new MockAssistantStream();
        queueMicrotask(() => {
          const message = assistant("configured");
          stream.push({ type: "done", reason: "stop", message });
        });
        return stream;
      },
      compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
    });

    await runtime.run("use frozen transport");
    expect(observedOptions).toMatchObject({
      transport: "sse",
      onPayload: hostedPayload,
      maxRetries: 0,
    });
    expect(observedOptions?.signal).toBeInstanceOf(AbortSignal);
  });

  it("restores active Pi context from PostgreSQL without whole-history snapshots", async () => {
    const storage = await createStorage();
    const contexts: Context[] = [];
    const run = async (prompt: string, answerText: string) => {
      const authority = new TestAuthority();
      const runtime = new CloudAgentRuntime({
        lane: "main",
        session: storage.asSession(),
        authority,
        model: getModel("openai", "gpt-4o-mini"),
        systemPrompt: "test",
        streamFn: scriptedStream([answerText], contexts),
        compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
      });
      expect(await runtime.run(prompt)).toMatchObject({
        kind: "completed",
        finalMessage: { content: [{ type: "text", text: answerText }] },
      });
      expect(authority.closed).toBe(false);
      await authority.close();
      expect(authority.closed).toBe(true);
    };

    await run("first", "answer-1");
    await run("second", "answer-2");

    expect(contexts).toHaveLength(2);
    expect(JSON.stringify(contexts[0]?.messages)).toContain("first");
    expect(JSON.stringify(contexts[1]?.messages)).toContain("answer-1");
    expect(JSON.stringify(contexts[1]?.messages)).toContain("second");
    expect(await storage.getStats()).toMatchObject({ messageCount: 4 });
    expect(await storage.findOpenOperations("main", { limit: 2 })).toEqual([]);
  });

  it("runs independent Agent Loops on branched lanes without copying or crossing context", async () => {
    const storage = await createStorage();
    const session = storage.asSession();
    await session.appendMessage({ role: "user", content: "shared-root", timestamp: Date.now() });
    const forkPoint = await session.getLeafId();
    await session.createLane("child-a", forkPoint);
    await session.createLane("child-b", forkPoint);
    const contextsA: Context[] = [];
    const contextsB: Context[] = [];

    await new CloudAgentRuntime({
      session,
      lane: "child-a",
      authority: new TestAuthority(),
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      streamFn: scriptedStream(["answer-a"], contextsA),
      compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
    }).run("task-a");
    await new CloudAgentRuntime({
      session: storage.asSession(),
      lane: "child-b",
      authority: new TestAuthority(),
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      streamFn: scriptedStream(["answer-b"], contextsB),
      compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
    }).run("task-b");

    expect(JSON.stringify(contextsA[0]?.messages)).toContain("shared-root");
    expect(JSON.stringify(contextsB[0]?.messages)).toContain("shared-root");
    expect(JSON.stringify(contextsB[0]?.messages)).not.toContain("answer-a");
    expect(JSON.stringify(await session.view("child-a").findEntriesOnBranch())).toContain(
      "answer-a",
    );
    expect(JSON.stringify(await session.view("child-b").findEntriesOnBranch())).toContain(
      "answer-b",
    );
    expect(JSON.stringify(await session.view("main").findEntriesOnBranch())).not.toContain(
      "answer-a",
    );
  });

  it("persists decorated Provider content and exposes restored context to payload transforms", async () => {
    const storage = await createStorage();
    const first = new CloudAgentRuntime({
      lane: "main",
      session: storage.asSession(),
      authority: new TestAuthority(),
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      streamFn: scriptedStream(["searched answer"]),
      decorateAssistantMessage(message) {
        (message.content as unknown[]).splice(0, 0, {
          type: "providerHostedToolCall",
          toolName: "web_search",
          nativeItem: { type: "web_search_call", id: "ws-1" },
        });
      },
      compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
    });
    await first.run("search once");

    let sawRestoredHostedContent = false;
    const second = new CloudAgentRuntime({
      lane: "main",
      session: storage.asSession(),
      authority: new TestAuthority(),
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      transformProviderPayload(payload, context) {
        sawRestoredHostedContent = JSON.stringify(context.messages).includes(
          "providerHostedToolCall",
        );
        return payload;
      },
      streamFn: async (model, context, options) => {
        await options?.onPayload?.({ input: [] }, model);
        return scriptedStream(["restored"])(model, context);
      },
      compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
    });
    await second.run("continue");

    expect(sawRestoredHostedContent).toBe(true);
    expect(JSON.stringify(await storage.findEntries({ type: "message" }))).toContain(
      "providerHostedToolCall",
    );
  });

  it("commits a complete assistant message independently of public event delivery", async () => {
    const storage = await createStorage();
    const runtime = new CloudAgentRuntime({
      lane: "main",
      session: storage.asSession(),
      authority: new TestAuthority(),
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      streamFn: scriptedStream(["durable answer"]),
      compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
      async onEvent(event) {
        if (event.type !== "message_end" || event.message.role !== "assistant") return;
        throw new Error("public stream unavailable after message commit");
      },
    });

    await expect(runtime.run("keep message persistence independent")).rejects.toThrow(
      "public stream unavailable after message commit",
    );
    expect(await storage.findEntries({ type: "message" })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "durable answer" }],
          }),
        }),
      ]),
    );
  });

  it("keeps a failed visible assistant prefix in the next native Pi context", async () => {
    const storage = await createStorage();
    const failedRuntime = new CloudAgentRuntime({
      lane: "main",
      session: storage.asSession(),
      authority: new TestAuthority(),
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      streamFn: () => {
        const stream = new MockAssistantStream();
        queueMicrotask(() => {
          stream.push({
            type: "error",
            reason: "error",
            error: {
              ...assistantError("transport failed"),
              content: [{ type: "text", text: "visible prefix" }],
            },
          });
        });
        return stream;
      },
      compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
    });
    await expect(failedRuntime.run("start a response")).resolves.toMatchObject({ kind: "failed" });

    const contexts: Context[] = [];
    const resumed = new CloudAgentRuntime({
      lane: "main",
      session: storage.asSession(),
      authority: new TestAuthority(),
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      streamFn: scriptedStream(["recovered"], contexts),
      compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
    });
    await resumed.run("continue");
    expect(JSON.stringify(contexts[0]?.messages)).toContain("visible prefix");
    expect(JSON.stringify(contexts[0]?.messages)).toContain("<turn_aborted>");
  });

  it("records Tool intent before the effect and binds it to the same authority", async () => {
    const storage = await createStorage();
    const reads = vi.spyOn(storage, "findEntriesOnBranch");
    const authority = new TestAuthority();
    let request = 0;
    let executed = false;
    const checkpoints: Array<{
      operation: PiSessionMutationOperation;
      sourceEvent: CloudAgentRuntimeEvent;
    }> = [];
    const session = storage.asSession();
    const runtime = new CloudAgentRuntime({
      lane: "main",
      session,
      authority,
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      tools: [
        {
          name: "mutate",
          label: "Mutate",
          description: "mutate the workspace",
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          } as any,
          async execute() {
            expect(reads).toHaveBeenCalledTimes(1);
            expect(checkpoints.map(({ sourceEvent }) => sourceEvent.type)).toEqual([
              "message_end",
              "tool_execution_start",
            ]);
            expect(checkpoints[0]?.operation).toMatchObject({
              kind: "append_items",
              items: [
                { kind: "append_entry", entry: { type: "message" } },
                { kind: "append_record", record: { type: "usage" } },
              ],
            });
            expect(checkpoints[1]?.operation).toMatchObject({
              kind: "append_items",
              items: [{ kind: "append_record", record: { type: "tool_started" } }],
            });
            executed = true;
            return { content: [{ type: "text", text: "done" }], details: {} };
          },
        },
      ],
      streamFn: (_model, _context) => {
        const stream = new MockAssistantStream();
        queueMicrotask(() => {
          request += 1;
          const message =
            request === 1
              ? {
                  ...assistant(""),
                  content: [
                    { type: "toolCall" as const, id: "tool-1", name: "mutate", arguments: {} },
                  ],
                  stopReason: "toolUse" as const,
                }
              : assistant("verified");
          stream.push({
            type: "done",
            reason: request === 1 ? "toolUse" : "stop",
            message,
          });
        });
        return stream;
      },
      commitCheckpoint: async (operation, sourceEvent) => {
        if (operation.kind !== "append_items") {
          throw new Error("Cloud checkpoint must use one atomic append batch");
        }
        for (const item of operation.items) {
          if (item.kind === "append_entry") await session.appendEntry(item.entry, item.lane);
          else await session.appendRecord(item.record);
        }
        if (sourceEvent !== undefined) checkpoints.push({ operation, sourceEvent });
      },
      compaction: { enabled: true, reserveTokens: 100, keepRecentTokens: 100 },
    });

    expect(await runtime.run("change it")).toMatchObject({ kind: "completed" });
    expect(executed).toBe(true);
    expect(reads).toHaveBeenCalledTimes(2);
    const [tool] = await storage.findRecords({ type: "tool_started" });
    expect(tool).toMatchObject({ toolCallId: "tool-1", toolName: "mutate", replay: "never" });
    expect(await storage.getEntry(tool!.resultEntryId)).toMatchObject({
      type: "message",
      message: { role: "toolResult", toolCallId: "tool-1", isError: false },
    });
    expect(checkpoints.map(({ sourceEvent }) => sourceEvent.type)).toEqual([
      "message_end",
      "tool_execution_start",
      "message_end",
      "message_end",
    ]);
  });

  it.each([{}, { path: "/workspace/file.txt", cwd: "/ignored" }])(
    "does not persist execution intent for Tool arguments rejected by Pi: %j",
    async (arguments_) => {
      const storage = await createStorage();
      const session = storage.asSession();
      const checkpointEvents: CloudAgentRuntimeEvent[] = [];
      let request = 0;
      let executed = false;
      const runtime = new CloudAgentRuntime({
        lane: "main",
        session,
        authority: new TestAuthority(),
        model: getModel("openai", "gpt-4o-mini"),
        systemPrompt: "test",
        tools: [
          {
            name: "required_path",
            label: "Required path",
            description: "requires one path",
            parameters: {
              type: "object",
              properties: { path: { type: "string" } },
              required: ["path"],
              additionalProperties: false,
            } as any,
            async execute() {
              executed = true;
              return { content: [{ type: "text", text: "unexpected" }], details: {} };
            },
          },
        ],
        streamFn: () => {
          const stream = new MockAssistantStream();
          queueMicrotask(() => {
            request += 1;
            stream.push({
              type: "done",
              reason: request === 1 ? "toolUse" : "stop",
              message:
                request === 1
                  ? {
                      ...assistant(""),
                      content: [
                        {
                          type: "toolCall",
                          id: "invalid-tool-1",
                          name: "required_path",
                          arguments: arguments_,
                        },
                      ],
                      stopReason: "toolUse",
                    }
                  : assistant("validation handled"),
            });
          });
          return stream;
        },
        commitCheckpoint: async (operation, sourceEvent) => {
          if (operation.kind !== "append_items") throw new Error("Expected atomic append batch");
          for (const item of operation.items) {
            if (item.kind === "append_entry") await session.appendEntry(item.entry, item.lane);
            else await session.appendRecord(item.record);
          }
          if (sourceEvent !== undefined) checkpointEvents.push(sourceEvent);
        },
        compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
      });

      await expect(runtime.run("validate first")).resolves.toMatchObject({ kind: "completed" });
      expect(executed).toBe(false);
      expect(checkpointEvents.map((event) => event.type)).not.toContain("tool_execution_start");
      await expect(storage.findRecords({ type: "tool_started" })).resolves.toHaveLength(0);
      expect(JSON.stringify(await storage.findEntries())).toContain("Validation failed");
    },
  );

  it("keeps a bounded product follow-up inside the same native Agent Run", async () => {
    const storage = await createStorage();
    const contexts: Context[] = [];
    let followUpAvailable = true;
    const runtime = new CloudAgentRuntime({
      lane: "main",
      session: storage.asSession(),
      authority: new TestAuthority(),
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      streamFn: scriptedStream(["first answer", "verified answer"], contexts),
      compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
      prepareFollowUp() {
        if (!followUpAvailable) return undefined;
        followUpAvailable = false;
        return {
          role: "custom",
          customType: "pi-cloud.test_follow_up",
          content: "verify before settling",
          display: false,
          timestamp: Date.now(),
        };
      },
    });

    const result = await runtime.run("make a change");
    expect(result.finalMessage.content).toEqual([{ type: "text", text: "verified answer" }]);
    expect(contexts).toHaveLength(2);
    expect(JSON.stringify(contexts[1]?.messages)).toContain("verify before settling");
    expect((await storage.getStats()).messageCount).toBe(4);
  });

  it("retries a transient model failure without adding the failed assistant to context", async () => {
    const storage = await createStorage();
    const contexts: Context[] = [];
    const events: string[] = [];
    let request = 0;
    const runtime = new CloudAgentRuntime({
      lane: "main",
      session: storage.asSession(),
      authority: new TestAuthority(),
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      streamFn: (_model, context) => {
        contexts.push(structuredClone(context));
        const stream = new MockAssistantStream();
        queueMicrotask(() => {
          request += 1;
          const message = request === 1 ? assistantError("network error") : assistant("recovered");
          if (message.stopReason === "error") {
            stream.push({ type: "error", reason: "error", error: message });
          } else {
            stream.push({ type: "done", reason: "stop", message });
          }
        });
        return stream;
      },
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
      compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
      onEvent(event) {
        events.push(event.type);
      },
    });

    expect(await runtime.run("recover transport")).toMatchObject({
      kind: "completed",
      finalMessage: { content: [{ type: "text", text: "recovered" }] },
    });
    expect(contexts).toHaveLength(2);
    expect(JSON.stringify(contexts[1]?.messages)).toContain("recover transport");
    expect(JSON.stringify(contexts[1]?.messages)).not.toContain("network error");
    expect(events).toContain("auto_retry_start");
    expect(events).toContain("auto_retry_end");
    expect((await storage.getStats()).messageCount).toBe(2);
    expect(await storage.findRecords({ type: "step_attempt" })).toHaveLength(2);
  });

  it("retries interrupted model sampling without replaying Tools or losing visible text", async () => {
    const storage = await createStorage();
    const contexts: Context[] = [];
    const events: CloudAgentRuntimeEvent[] = [];
    const effects: string[] = [];
    const toolCall = (id: string): AssistantMessage => ({
      ...assistant(""),
      content: [{ type: "toolCall", id, name: "mutate", arguments: {} }],
      stopReason: "toolUse",
    });
    const disconnected =
      "Codex error: stream error: stream disconnected before completion: stream closed before response.completed";
    const responses: AssistantMessage[] = [
      toolCall("effect-1"),
      {
        ...assistantError(disconnected),
        content: [
          { type: "text", text: "visible-before-disconnect" },
          ...toolCall("incomplete-never-execute").content,
        ],
      },
      toolCall("effect-2"),
      assistantError(disconnected),
      assistant("recovered"),
    ];
    let request = 0;
    const runtime = new CloudAgentRuntime({
      lane: "main",
      session: storage.asSession(),
      authority: new TestAuthority(),
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      tools: [
        {
          name: "mutate",
          label: "Mutate",
          description: "test effect",
          parameters: { type: "object", properties: {} } as any,
          async execute(id) {
            effects.push(id);
            return { content: [{ type: "text", text: `done-${id}` }], details: {} };
          },
        },
      ],
      streamFn: (_model, context) => {
        contexts.push({ ...context, messages: structuredClone(context.messages) });
        const stream = new MockAssistantStream();
        const message = responses[request++]!;
        queueMicrotask(() => {
          if (message.stopReason === "error")
            stream.push({ type: "error", reason: "error", error: message });
          else
            stream.push({
              type: "done",
              reason: message.stopReason as "stop" | "toolUse",
              message,
            });
        });
        return stream;
      },
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
      compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
      onEvent(event) {
        events.push(event);
      },
    });
    const result = await runtime.run("change things");
    expect(result.kind, JSON.stringify(result)).toBe("completed");
    expect(effects).toEqual(["effect-1", "effect-2"]);
    expect(request).toBe(5);
    expect(events.filter((e) => e.type === "auto_retry_start").map((e) => e.attempt)).toEqual([
      1, 1,
    ]);
    expect(await storage.findRecords({ type: "tool_started" })).toHaveLength(2);
    expect(JSON.stringify(contexts[2]?.messages)).toContain("done-effect-1");
    expect(JSON.stringify(contexts[2]?.messages)).toContain("visible-before-disconnect");
    expect(JSON.stringify(contexts[2]?.messages)).not.toContain("incomplete-never-execute");
    const restored: Context[] = [];
    await new CloudAgentRuntime({
      lane: "main",
      session: storage.asSession(),
      authority: new TestAuthority(),
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      streamFn: scriptedStream(["next turn"], restored),
      compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
    }).run("continue");
    expect(JSON.stringify(restored[0]?.messages).match(/visible-before-disconnect/g)).toHaveLength(
      1,
    );
    expect(JSON.stringify(restored[0]?.messages)).not.toContain("incomplete-never-execute");
  });

  it.each([
    ["stream disconnected before completion: stream closed before response.completed", 3],
    ["invalid_api_key", 1],
    ["insufficient_quota", 1],
    ["invalid_request_error", 1],
  ])(
    "bounds retries and preserves permanent failures: %s",
    async (errorMessage, expectedRequests) => {
      const storage = await createStorage();
      let requests = 0;
      const runtime = new CloudAgentRuntime({
        lane: "main",
        session: storage.asSession(),
        authority: new TestAuthority(),
        model: getModel("openai", "gpt-4o-mini"),
        systemPrompt: "test",
        streamFn: () => {
          requests++;
          const stream = new MockAssistantStream();
          queueMicrotask(() =>
            stream.push({ type: "error", reason: "error", error: assistantError(errorMessage) }),
          );
          return stream;
        },
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
        compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
      });
      expect(await runtime.run("test error policy")).toMatchObject({ kind: "failed" });
      expect(requests).toBe(expectedRequests);
      expect(await storage.findRecords({ type: "tool_started" })).toHaveLength(0);
    },
  );

  it("does not start another model request after authority is revoked during retry backoff", async () => {
    const storage = await createStorage();
    const authority = new TestAuthority();
    let requests = 0;
    const runtime = new CloudAgentRuntime({
      lane: "main",
      session: storage.asSession(),
      authority,
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      streamFn: () => {
        requests++;
        const stream = new MockAssistantStream();
        queueMicrotask(() =>
          stream.push({
            type: "error",
            reason: "error",
            error: assistantError("stream closed before response.completed"),
          }),
        );
        return stream;
      },
      retry: { enabled: true, maxRetries: 2, baseDelayMs: 10 },
      compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
      onEvent(event) {
        if (event.type === "auto_retry_start") authority.revoke();
      },
    });
    await expect(runtime.run("cancel retry")).rejects.toThrow();
    expect(requests).toBe(1);
  });

  it("settles an unresolved Tool as unknown instead of replaying it", async () => {
    const storage = await createStorage();
    const session = storage.asSession();
    const operationId = globalThis.crypto.randomUUID();
    const assistantEntryId = globalThis.crypto.randomUUID();
    const resultEntryId = globalThis.crypto.randomUUID();
    await session.appendRecord({
      id: operationId,
      lane: "main",
      type: "operation_started",
      sourceLeafId: null,
      intent: { kind: "run", originalPrompt: [], initialMessages: [] },
    });
    await session.appendEntry(
      {
        id: assistantEntryId,
        type: "message",
        message: {
          ...assistant(""),
          content: [{ type: "toolCall", id: "unknown-1", name: "bash", arguments: {} }],
          stopReason: "toolUse",
        },
      },
      "main",
    );
    await session.appendRecord({
      id: globalThis.crypto.randomUUID(),
      lane: "main",
      type: "tool_started",
      runId: operationId,
      assistantEntryId,
      toolIndex: 0,
      toolCallId: "unknown-1",
      toolName: "bash",
      effectiveArgs: {},
      resultEntryId,
      replay: "never",
    });
    const contexts: Context[] = [];
    const runtime = new CloudAgentRuntime({
      lane: "main",
      session,
      authority: new TestAuthority(),
      model: getModel("openai", "gpt-4o-mini"),
      systemPrompt: "test",
      streamFn: scriptedStream(["recovered"], contexts),
      compaction: { enabled: false, reserveTokens: 100, keepRecentTokens: 100 },
    });

    await runtime.run("continue");
    expect(await session.getEntry(resultEntryId)).toMatchObject({
      type: "message",
      message: { role: "toolResult", isError: true },
    });
    expect(JSON.stringify(contexts[0]?.messages)).toContain("side effects are unknown");
    expect(JSON.stringify(contexts[0]?.messages)).toContain("<turn_aborted>");
  });

  it("writes a native compaction entry before sampling an oversized active context", async () => {
    const storage = await createStorage();
    const session = storage.asSession();
    await session.appendMessage({
      role: "user",
      content: "x".repeat(2_000),
      timestamp: Date.now(),
    });
    await session.appendMessage({
      ...assistant("old answer"),
      usage: {
        input: 50_000,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 50_001,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const contexts: Context[] = [];
    const model = { ...getModel("openai", "gpt-4o-mini"), contextWindow: 256 };
    const stream = scriptedStream(["after compaction"], contexts);
    const models = {
      streamSimple: stream,
      async completeSimple() {
        return assistant("summary of earlier work");
      },
    } as unknown as Models;
    const events: CloudAgentRuntimeEvent[] = [];
    const runtime = new CloudAgentRuntime({
      lane: "main",
      session,
      authority: new TestAuthority(),
      model,
      models,
      systemPrompt: "test",
      compaction: { enabled: true, reserveTokens: 32, keepRecentTokens: 32 },
      onEvent(event) {
        events.push(event);
      },
    });

    await runtime.run("continue after compacting");
    expect((await storage.findEntries({ type: "compaction" })).length).toBe(1);
    expect(events.some((event) => event.type === "compaction_start")).toBe(true);
    const completedCompaction = events.find(
      (event) => event.type === "compaction_end" && "success" in event && event.success,
    );
    expect(completedCompaction).toBeDefined();
    if (completedCompaction === undefined || !("result" in completedCompaction)) {
      throw new Error("Expected the Cloud runtime compaction result event");
    }
    expect(completedCompaction?.result?.estimatedTokensAfter).toBeLessThan(
      completedCompaction?.result?.tokensBefore ?? 0,
    );
    expect(JSON.stringify(contexts[0]?.messages)).toContain("summary of earlier work");
  });

  it("retains one selected Harness fact through Compaction and a replacement Runtime", async () => {
    const storage = await createStorage();
    const session = storage.asSession();
    const customType = "pi-cloud.workspace_changed";
    const content = [
      "<workspace_changed>",
      "This session is now attached to a different workspace.",
      "</workspace_changed>",
    ].join("\n");
    await session.appendCustomEntry(customType, {
      content,
      details: { schemaVersion: 1, changeSha256: "a".repeat(64) },
    });
    await session.appendMessage({
      role: "user",
      content: "x".repeat(2_000),
      timestamp: Date.now(),
    });
    await session.appendMessage({
      ...assistant("old answer"),
      usage: {
        input: 50_000,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 50_001,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    });
    const projector: CustomEntryContextMessageProjector = (entry) => {
      if (
        entry.customType !== customType ||
        typeof entry.data !== "object" ||
        entry.data === null ||
        !("content" in entry.data) ||
        typeof entry.data.content !== "string"
      ) {
        return undefined;
      }
      return [
        {
          role: "custom",
          customType,
          content: entry.data.content,
          display: false,
          timestamp: entry.timestamp,
        } as AgentMessage,
      ];
    };
    const entryProjectors = { [customType]: projector };
    const firstContexts: Context[] = [];
    const model = { ...getModel("openai", "gpt-4o-mini"), contextWindow: 256 };
    const first = new CloudAgentRuntime({
      lane: "main",
      session,
      authority: new TestAuthority(),
      model,
      models: {
        streamSimple: scriptedStream(["after compaction"], firstContexts),
        async completeSimple() {
          return assistant("summary without copied Harness markup");
        },
      } as unknown as Models,
      systemPrompt: "test",
      entryProjectors,
      compactionRetainedCustomTypes: [customType],
      compaction: { enabled: true, reserveTokens: 32, keepRecentTokens: 32 },
    });
    await first.run("continue after compacting");

    const count = (value: unknown): number =>
      (JSON.stringify(value).match(/<workspace_changed>/g) ?? []).length;
    expect(count(firstContexts[0]?.messages)).toBe(1);
    const [compaction] = await storage.findEntries({ type: "compaction" });
    if (compaction?.type !== "compaction") throw new Error("Expected a Compaction entry");
    expect(count(compaction.retainedTail)).toBe(1);

    const replacementContexts: Context[] = [];
    const replacement = new CloudAgentRuntime({
      lane: "main",
      session: storage.asSession(),
      authority: new TestAuthority(),
      model,
      streamFn: scriptedStream(["replacement answer"], replacementContexts),
      systemPrompt: "test",
      entryProjectors,
      compactionRetainedCustomTypes: [customType],
      compaction: { enabled: false, reserveTokens: 32, keepRecentTokens: 32 },
    });
    await replacement.run("continue on another Worker");
    expect(count(replacementContexts[0]?.messages)).toBe(1);
  });
});
