import { expect, it, vi } from "vitest";
import { Harness, LiveDoc, MemoryStorage, createRegistry } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { isHostedToolBlock } from "../src/provider-hosted-transcript.ts";
import { providerTextPhase } from "../src/durable/provider-response.ts";
import {
  modelHttpFixture,
  controlled,
  success,
  created,
  textItem,
  added,
  delta,
  done,
  terminal,
  JournalStorage,
  assistantMessages,
} from "./fixtures/model-http.ts";

it.each(["openai-codex", "deepseek"] as const)(
  "native Harness retries Gateway connection loss on %s",
  async (provider) => {
    const f = await modelHttpFixture(provider, (attempt) => {
      if (attempt === 1) throw new TypeError("fetch failed");
      return success();
    });
    const { harness, root } = await f.harness();
    try {
      const input = await root.submit(
        { type: "input", content: "retry fixture" },
        BACKGROUND_CONTEXT,
      );
      expect((await input.wait(BACKGROUND_CONTEXT)).status).toBe("done");
      expect(f.payloads).toHaveLength(2);
      expect(f.outcomes.map((o) => o.outcome)).toEqual(["error", "completed"]);
      expect(f.releases()).toBe(2);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      await f.close();
    }
  },
);

it.each(["openai-codex", "deepseek"] as const)(
  "a spent cloud request budget stays terminal on %s",
  async (provider) => {
    const f = await modelHttpFixture(provider, () => success(), { maximumRequests: 1 });
    const { harness, root } = await f.harness();
    try {
      const first = await root.submit(
        { type: "input", content: "consume budget" },
        BACKGROUND_CONTEXT,
      );
      expect((await first.wait(BACKGROUND_CONTEXT)).status).toBe("done");
      const next = await root.submit(
        { type: "input", content: "budget is spent" },
        BACKGROUND_CONTEXT,
      );
      expect((await next.wait(BACKGROUND_CONTEXT)).status).toBe("unanswered");
      expect(f.payloads).toHaveLength(1);
      expect(f.outcomes.map((o) => o.outcome)).toEqual(["completed", "error"]);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      await f.close();
    }
  },
);

it.each([
  ["openai-codex", 500, "temporary backend problem", 2],
  ["deepseek", 500, "temporary backend problem", 2],
  ["openai-codex", 500, "billing quota exceeded", 1],
  ["deepseek", 500, "billing quota exceeded", 1],
  ["openai-codex", 400, "invalid model configuration", 1],
  ["deepseek", 400, "invalid model configuration", 1],
] as const)(
  "native error policy keeps %s HTTP %s / %s at %s sends",
  async (provider, status, message, sends) => {
    const f = await modelHttpFixture(provider, (attempt) =>
      attempt > 1 ? success() : new Response(JSON.stringify({ error: { message } }), { status }),
    );
    const { harness, root } = await f.harness();
    try {
      const input = await root.submit(
        { type: "input", content: "error policy" },
        BACKGROUND_CONTEXT,
      );
      expect((await input.wait(BACKGROUND_CONTEXT)).status).toBe(
        sends === 2 ? "done" : "unanswered",
      );
      expect(f.payloads).toHaveLength(sends);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      await f.close();
    }
  },
);

it.each(["openai-codex", "deepseek"] as const)(
  "native Harness preserves partial text and retries a broken %s stream",
  async (provider) => {
    const f = await modelHttpFixture(provider, (attempt, signal) => {
      if (attempt > 1) return success();
      const stream = controlled(signal);
      stream.send(created, added(textItem("partial", "commentary"), 0), delta(0, "Partial text"));
      setTimeout(() => stream.fail(), 30);
      return stream.response;
    });
    const { harness, root } = await f.harness();
    try {
      const input = await root.submit(
        { type: "input", content: "retry fixture" },
        BACKGROUND_CONTEXT,
      );
      expect((await input.wait(BACKGROUND_CONTEXT)).status).toBe("done");
      expect(f.payloads).toHaveLength(2);
      const messages = assistantMessages(
        (await root.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items,
      );
      expect(
        messages.some(
          (m) =>
            m.stopReason === "error" &&
            m.content.some((b) => b.type === "text" && b.text === "Partial text"),
        ),
      ).toBe(true);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      await f.close();
    }
  },
);

it("native Stop and cold reopening retain an acknowledged hosted-only partial", async () => {
  const reached = Promise.withResolvers<ReturnType<typeof controlled>>();
  const f = await modelHttpFixture("openai-codex", (_attempt, signal) => {
    const stream = controlled(signal);
    reached.resolve(stream);
    return stream.response;
  });
  const store = new JournalStorage();
  const { harness, root } = await f.harness(store);
  try {
    const input = await root.submit({ type: "input", content: "search" }, BACKGROUND_CONTEXT);
    const upstream = await reached.promise;
    const search = {
      type: "web_search_call",
      id: "search-1",
      status: "completed",
      action: { type: "search", query: "native prefix" },
    };
    upstream.send(created, added({ ...search, status: "in_progress" }, 0), done(search, 0));
    await vi.waitFor(async () => {
      const live = await harness.snapshot(LiveDoc, root.id, BACKGROUND_CONTEXT);
      expect(live?.generation?.message?.content.some(isHostedToolBlock)).toBe(true);
    });
    await root.abort(BACKGROUND_CONTEXT);
    expect((await input.wait(BACKGROUND_CONTEXT)).status).toBe("unanswered");
    const messages = assistantMessages(
      (await root.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items,
    );
    expect(
      messages.find((m) => m.stopReason === "aborted")?.content.filter(isHostedToolBlock),
    ).toHaveLength(1);
    const restored = new MemoryStorage();
    for (const writes of store.journal) await restored.commit(writes, BACKGROUND_CONTEXT);
    const cold = await Harness.open(
      restored,
      { models: f.scoped.models, registry: createRegistry() },
      BACKGROUND_CONTEXT,
    );
    try {
      const conversation = await cold.conversation(root.id, BACKGROUND_CONTEXT);
      const entries = await conversation!.entries({}, 100, undefined, BACKGROUND_CONTEXT);
      expect(
        assistantMessages(entries.items)
          .flatMap((m) => m.content)
          .filter(isHostedToolBlock),
      ).toHaveLength(1);
      expect(f.payloads).toHaveLength(1);
    } finally {
      await cold.close(BACKGROUND_CONTEXT);
    }
  } finally {
    await harness.close(BACKGROUND_CONTEXT);
    await f.close();
  }
});

it("real Codex parsing keeps commentary/final phases after a thinking item", async () => {
  const f = await modelHttpFixture("openai-codex", () => {
    const reasoning = {
      type: "reasoning",
      id: "rs-1",
      summary: [{ type: "summary_text", text: "Plan" }],
    };
    const commentary = textItem("comment", "commentary", "Checking"),
      final = textItem("final", "final_answer", "Done");
    return new Response(
      [
        created,
        added(reasoning, 0),
        added(textItem("comment", "commentary"), 1),
        delta(1, "Checking"),
        added(textItem("final", "final_answer"), 2),
        delta(2, "Done"),
        done(reasoning, 0),
        done(commentary, 1),
        done(final, 2),
        terminal([reasoning, commentary, final]),
      ]
        .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
        .join(""),
    );
  });
  try {
    const { result, events } = await f.run();
    expect(result.stopReason).toBe("stop");
    for (const event of events)
      if (event.type === "text_delta") {
        const block = event.partial.content[event.contentIndex]!;
        if (block.type !== "text") throw new Error("Expected text");
        expect(providerTextPhase(block)).toBe(
          block.text === "Checking" ? "commentary" : "final_answer",
        );
      }
  } finally {
    await f.close();
  }
});

it("semantic success remains successful when Codex closes before HTTP EOF", async () => {
  const f = await modelHttpFixture("openai-codex", (_attempt, signal) => {
    const stream = controlled(signal),
      item = textItem("final", "final_answer", "Done");
    stream.send(
      created,
      added(textItem("final", "final_answer"), 0),
      delta(0, "Done"),
      done(item, 0),
      terminal([item]),
    );
    return stream.response;
  });
  try {
    expect((await f.run()).result.stopReason).toBe("stop");
    expect(f.outcomes.map((o) => o.outcome)).toEqual(["completed"]);
    await vi.waitFor(async () =>
      expect(await f.metrics.registry.metrics()).toContain('outcome="disconnected"'),
    );
    expect(await f.metrics.registry.metrics()).not.toContain(
      'pi_cloud_model_execution_seconds_count{provider="openai-codex",model="gpt-6-luna",outcome="error"}',
    );
  } finally {
    await f.close();
  }
});

it.each(["openai-codex", "deepseek"] as const)(
  "replays hosted-only native history at the exact payload position on %s",
  async (provider) => {
    const search = {
      type: "web_search_call",
      id: "search-replay",
      status: "completed",
      action: { type: "search", query: "actual payload" },
    };
    const f = await modelHttpFixture(provider, (attempt) =>
      attempt > 1
        ? success()
        : new Response(
            [
              created,
              added({ ...search, status: "in_progress" }, 0),
              done(search, 0),
              terminal([search]),
            ]
              .map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
              .join(""),
            { headers: { "content-type": "text/event-stream" } },
          ),
    );
    const { harness, root } = await f.harness();
    try {
      const first = await root.submit({ type: "input", content: "first" }, BACKGROUND_CONTEXT);
      expect((await first.wait(BACKGROUND_CONTEXT)).status).toBe("done");
      const second = await root.submit({ type: "input", content: "second" }, BACKGROUND_CONTEXT);
      expect((await second.wait(BACKGROUND_CONTEXT)).status).toBe("done");
      const payload = f.payloads[1]!;
      expect(JSON.stringify(payload)).not.toContain("msg_picloud_hosted_");
      const input = payload.input as { type: string; role?: string; id?: string }[];
      const position = input.findIndex((item) => item.id === search.id);
      expect(position).toBeGreaterThanOrEqual(0);
      expect(input[position]!.type).toBe("web_search_call");
      expect(input.slice(position + 1).some((item) => item.role === "user")).toBe(true);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      await f.close();
    }
  },
);
