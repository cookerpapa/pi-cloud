import { InMemorySessionRepo, type Session } from "@earendil-works/pi-agent-core";
import {
  EventStream,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import {
  CloudAgentInputClosedError,
  CloudAgentRuntime,
  type CloudAgentRuntimeEvent,
  type CloudAgentRuntimeOptions,
} from "../src/cloud-agent-runtime.ts";

const model: Model<"openai-responses"> = {
  id: "gpt-6-luna",
  name: "Scripted Luna lifecycle fixture",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "http://127.0.0.1:1",
  reasoning: false,
  input: ["text"],
  contextWindow: 10_000,
  maxTokens: 1_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

function response(text = "done", failed = false): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: failed ? "error" : "stop",
    ...(failed ? { errorMessage: "network error" } : {}),
    timestamp: Date.now(),
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  };
}

async function fixture(
  options: Partial<CloudAgentRuntimeOptions> = {},
  responses: AssistantMessage[] = [],
) {
  const session = options.session ?? (await new InMemorySessionRepo().create());
  const authority = options.authority ?? {
    signal: new AbortController().signal,
    assertCurrent: async () => {},
    close: async () => {},
  };
  const contexts: Context[] = [];
  const runtime = new CloudAgentRuntime({
    session,
    lane: "main",
    authority,
    model,
    systemPrompt: "fixture",
    compaction: { enabled: false, reserveTokens: 1_000, keepRecentTokens: 100 },
    streamFn: (_model, context) => {
      contexts.push(structuredClone(context));
      const message = responses.shift() ?? response();
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
            : { type: "done", reason: "stop", message },
        ),
      );
      return stream;
    },
    ...options,
  });
  return { runtime, session, authority, contexts };
}

function finalAppendGate(session: Session) {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const append = session.appendRecord.bind(session);
  vi.spyOn(session, "appendRecord").mockImplementation(async (record) => {
    if (record.type === "operation_finished") {
      entered.resolve();
      await release.promise;
    }
    return append(record);
  });
  return { entered, release };
}

describe("native Run lifecycle boundaries", () => {
  it.each(["steer", "follow_up", "notify", "human"] as const)(
    "consumes %s accepted at agent_end within the same operation",
    async (delivery) => {
      let runtime!: CloudAgentRuntime;
      let delivered = false;
      const f = await fixture({
        onEvent: async (event) => {
          if (event.type !== "agent_end" || delivered) return;
          delivered = true;
          if (delivery === "human") await runtime.steer("late input");
          else await runtime.agentInput("late", "late input", delivery);
        },
      });
      runtime = f.runtime;
      expect(await runtime.run("start")).toMatchObject({ kind: "completed" });
      expect(f.contexts).toHaveLength(2);
      expect(JSON.stringify(f.contexts[1])).toContain("late input");
      expect(await f.session.findRecords({ type: "operation_started" })).toHaveLength(1);
      expect(await f.session.findRecords({ type: "operation_finished" })).toHaveLength(1);
      const users = (await f.session.findEntries()).filter(
        (e) => e.type === "message" && e.message.role === "user",
      );
      expect(users).toHaveLength(2);
    },
  );

  it("rejects input while final persistence is still waiting", async () => {
    const f = await fixture();
    const gate = finalAppendGate(f.session);
    const running = f.runtime.run("start");
    try {
      await gate.entered.promise;
      await expect(f.runtime.steer("too late")).rejects.toBeInstanceOf(CloudAgentInputClosedError);
      await expect(f.runtime.agentInput("late", "too late", "follow_up")).rejects.toBeInstanceOf(
        CloudAgentInputClosedError,
      );
    } finally {
      gate.release.resolve();
    }
    expect(await running).toMatchObject({ kind: "completed" });
    expect(f.contexts).toHaveLength(1);
    expect(await f.session.getEntry("pc-agent-input-late")).toBeUndefined();
  });

  it("rechecks closure after a pending deduplication read", async () => {
    const session = await new InMemorySessionRepo().create();
    const dedupEntered = Promise.withResolvers<void>();
    const dedupRelease = Promise.withResolvers<void>();
    const get = session.getEntry.bind(session);
    vi.spyOn(session, "getEntry").mockImplementation(async (id) => {
      if (id === "pc-agent-input-racing") {
        dedupEntered.resolve();
        await dedupRelease.promise;
      }
      return get(id);
    });
    const gate = finalAppendGate(session);
    let runtime!: CloudAgentRuntime;
    let delivery: Promise<unknown> | undefined;
    const f = await fixture({
      session,
      onEvent: async (event) => {
        if (event.type !== "agent_end" || delivery) return;
        delivery = runtime.agentInput("racing", "late input", "steer").catch((error) => error);
        await dedupEntered.promise;
      },
    });
    runtime = f.runtime;
    const running = runtime.run("start");
    try {
      await gate.entered.promise;
      dedupRelease.resolve();
      expect(await delivery).toBeInstanceOf(CloudAgentInputClosedError);
    } finally {
      dedupRelease.resolve();
      gate.release.resolve();
    }
    expect(await running).toMatchObject({ kind: "completed" });
    expect(f.contexts).toHaveLength(1);
  });

  it("resets sampling retries after ordinary success before an in-Run follow-up", async () => {
    let offered = false;
    const events: CloudAgentRuntimeEvent[] = [];
    const f = await fixture(
      {
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 1 },
        onEvent: (event) => {
          events.push(event);
        },
        prepareFollowUp: () => {
          if (offered) return;
          offered = true;
          return { role: "user", content: "verify", timestamp: Date.now() };
        },
      },
      [
        response("", true),
        response("", true),
        response("first"),
        response("", true),
        response("verified"),
      ],
    );
    expect(await f.runtime.run("start")).toMatchObject({ kind: "completed" });
    expect(f.contexts).toHaveLength(5);
    expect(events.filter((e) => e.type === "auto_retry_start").map((e) => e.attempt)).toEqual([
      1, 2, 1,
    ]);
    expect(events.filter((e) => e.type === "auto_retry_end")).toMatchObject([
      { success: true, attempt: 2 },
      { success: true, attempt: 1 },
    ]);
    expect(
      (await f.session.findRecords({ type: "step_attempt", order: "oldestFirst" })).map(
        (r) => r.attempt,
      ),
    ).toEqual([1, 2, 3, 1, 2]);
  });

  it.each(["stale", "fresh usage", "large new input"] as const)(
    "uses the Compaction entry boundary when deciding thresholds: %s",
    async (scenario) => {
      const session = await new InMemorySessionRepo().create();
      const old = response("small old answer");
      old.timestamp = 1;
      old.usage.input = 9_500;
      old.usage.totalTokens = 9_501;
      await session.appendEntry(
        {
          id: "compacted",
          type: "compaction",
          summary: "short summary",
          tokensBefore: 9_501,
          retainedTail: [old],
        },
        "main",
      );
      if (scenario === "fresh usage") {
        // Even an old provider timestamp is fresh when its Entry follows compaction.
        await session.appendEntry({ id: "fresh", type: "message", message: old }, "main");
      }
      const summarize = vi.fn(async () => response("summary"));
      const f = await fixture({
        session,
        compaction: { enabled: true, reserveTokens: 1_000, keepRecentTokens: 100 },
        models: { completeSimple: summarize } as unknown as Models,
      });
      expect(
        await f.runtime.run(scenario === "large new input" ? "a".repeat(40_000) : "next"),
      ).toMatchObject({ kind: "completed" });
      if (scenario === "stale") expect(summarize).not.toHaveBeenCalled();
      else expect(summarize).toHaveBeenCalled();
      expect(f.contexts).toHaveLength(1);
    },
  );

  it("cancels backoff immediately, reports failure and preserves shared authority", async () => {
    vi.useFakeTimers();
    const scheduled = Promise.withResolvers<void>();
    const events: CloudAgentRuntimeEvent[] = [];
    const settled: unknown[] = [];
    const f = await fixture(
      {
        retry: { enabled: true, maxRetries: 2, baseDelayMs: 50_000 },
        onEvent: (event) => {
          events.push(event);
          if (event.type === "auto_retry_start") scheduled.resolve();
        },
      },
      [response("", true)],
    );
    const running = f.runtime.run("start").then((result) => {
      settled.push(result);
      return result;
    });
    try {
      await scheduled.promise;
      await vi.advanceTimersByTimeAsync(0);
      f.runtime.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(settled).toMatchObject([{ kind: "aborted" }]);
      expect(f.contexts).toHaveLength(1);
      expect(events.filter((e) => e.type === "auto_retry_end")).toMatchObject([
        { success: false, attempt: 1 },
      ]);
      expect(f.authority.signal.aborted).toBe(false);
      const sibling = await fixture({ authority: f.authority });
      expect(await sibling.runtime.run("sibling")).toMatchObject({ kind: "completed" });
    } finally {
      f.runtime.abort();
      await vi.runAllTimersAsync();
      await running;
      vi.useRealTimers();
    }
  });
});
