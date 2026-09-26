import { InMemorySessionRepo, type AgentTool } from "@earendil-works/pi-agent-core";
import {
  EventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { CloudAgentRuntime, type CloudAgentRuntimeOptions } from "../src/cloud-agent-runtime.ts";

// A revision-pinned test oracle, never a production dependency on private Pi APIs.
const { validateRecordLog } = await import(
  new URL(
    "./dist/harness/reducer.js",
    pathToFileURL(
      createRequire(import.meta.url).resolve("@earendil-works/pi-agent-core/package.json"),
    ),
  ).href
);

function assistant(
  content: AssistantMessage["content"],
  stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-4o-mini",
    content,
    stopReason,
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    ...(stopReason === "error" ? { errorMessage: "network error" } : {}),
  };
}
const call = (id: string, name = "effect") => ({
  type: "toolCall" as const,
  id,
  name,
  arguments: {},
});
const done = () => assistant([{ type: "text", text: "done" }]);

async function fixture(
  responses: AssistantMessage[],
  policies: Pick<CloudAgentRuntimeOptions, "beforeToolCall" | "afterToolCall" | "tools"> = {},
) {
  const session = await new InMemorySessionRepo().create();
  const effects: string[] = [];
  const tool: AgentTool = {
    name: "effect",
    label: "effect",
    description: "fixture",
    parameters: { type: "object", properties: {} } as any,
    async execute(id) {
      effects.push(id);
      return { content: [{ type: "text", text: "raw result" }], details: {} };
    },
  };
  const runtime = new CloudAgentRuntime({
    session,
    lane: "main",
    systemPrompt: "fixture",
    model: getModel("openai", "gpt-4o-mini"),
    authority: {
      signal: new AbortController().signal,
      assertCurrent: async () => {},
      close: async () => {},
    },
    tools: [tool],
    ...policies,
    compaction: { enabled: false, reserveTokens: 1, keepRecentTokens: 1 },
    retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
    streamFn: () => {
      const message = responses.shift();
      if (!message) throw new Error("Unexpected extra model request");
      const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
        (event) => event.type === "done" || event.type === "error",
        (event) =>
          event.type === "error"
            ? event.error
            : (event as Extract<AssistantMessageEvent, { type: "done" }>).message,
      );
      queueMicrotask(() =>
        stream.push(
          message.stopReason === "error"
            ? { type: "error", reason: "error", error: message }
            : { type: "done", reason: message.stopReason as "stop" | "toolUse", message },
        ),
      );
      return stream;
    },
  });
  const outcome = await runtime.run("fixture");
  const records = await session.findRecords({ order: "oldestFirst" });
  const entries = await session.findEntries({ order: "oldestFirst" });
  validateRecordLog({ lane: "main", openOperations: [], records, entries });
  return { records, entries, effects, outcome };
}

describe("Cloud execution conforms to native Pi Record and hook semantics", () => {
  it("rejects ambiguous IDs within one response before persisting it or executing effects", async () => {
    const result = await fixture([assistant([call("ambiguous"), call("ambiguous")], "toolUse")]);
    expect(result.outcome.kind).toBe("failed");
    expect(result.effects).toEqual([]);
    expect(result.records.some((record) => record.type === "tool_started")).toBe(false);
    expect(
      result.entries.some(
        (entry) => entry.type === "message" && entry.message.role === "assistant",
      ),
    ).toBe(false);
  });

  it.each([false, true])(
    "uses native parallel reads while preserving mutation batch ordering (mutation=%s)",
    async (mutation) => {
      let active = 0,
        maximum = 0;
      const tools = ["read", "write"].map((name): AgentTool => ({
        name,
        label: name,
        description: "fixture",
        parameters: { type: "object", properties: {} } as any,
        executionMode: name === "read" ? "parallel" : "sequential",
        async execute() {
          maximum = Math.max(maximum, ++active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active--;
          return { content: [{ type: "text", text: "completed" }], details: {} };
        },
      }));
      const result = await fixture(
        [
          assistant([call("one", "read"), call("two", mutation ? "write" : "read")], "toolUse"),
          done(),
        ],
        { tools },
      );
      expect(maximum).toBe(mutation ? 1 : 2);
      expect(
        result.records
          .filter((record) => record.type === "tool_started")
          .map((record) => record.toolIndex),
      ).toEqual([0, 1]);
    },
  );

  it("starts each completed sampling Step at one and increments only its retry", async () => {
    const result = await fixture([
      assistant([call("reused")], "toolUse"),
      assistant([], "error"),
      assistant([call("reused")], "toolUse"),
      done(),
    ]);
    expect(result.records.filter((r) => r.type === "step_attempt").map((r) => r.attempt)).toEqual([
      1, 1, 2, 1,
    ]);
    expect(result.effects).toEqual(["reused", "reused"]);
    const tools = result.records.filter((r) => r.type === "tool_started");
    expect(new Set(tools.map((r) => r.resultEntryId)).size).toBe(2);
    expect(tools.map((r) => r.toolCallId)).toEqual(["reused", "reused"]);
  });

  it("retains the original ordinal after Pi rejects an earlier unknown Tool", async () => {
    const result = await fixture([
      assistant([call("invalid", "missing"), call("valid")], "toolUse"),
      done(),
    ]);
    expect(result.effects).toEqual(["valid"]);
    expect(result.records.filter((r) => r.type === "tool_started")).toMatchObject([
      { toolIndex: 1, toolCallId: "valid" },
    ]);
  });

  it("blocks before intent and persists only the after-hook result", async () => {
    const result = await fixture(
      [assistant([call("blocked"), call("allowed")], "toolUse"), done()],
      {
        beforeToolCall: async ({ toolCall }) =>
          toolCall.id === "blocked" ? { block: true, reason: "policy declined" } : undefined,
        afterToolCall: async () => ({ content: [{ type: "text", text: "reviewed result" }] }),
      },
    );
    expect(result.effects).toEqual(["allowed"]);
    expect(result.records.filter((r) => r.type === "tool_started")).toMatchObject([
      { toolIndex: 1, toolCallId: "allowed" },
    ]);
    const messages = result.entries.flatMap((entry) =>
      entry.type === "message" && entry.message.role === "toolResult" ? [entry.message] : [],
    );
    expect(messages).toMatchObject([
      { toolCallId: "blocked", isError: true, content: [{ text: "policy declined" }] },
      { toolCallId: "allowed", isError: false, content: [{ text: "reviewed result" }] },
    ]);
  });
});
