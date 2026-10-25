import { expect, it, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  modelHttpFixture,
  success,
  controlled,
  created,
  textItem,
  added,
  delta,
  done,
  terminal,
} from "./fixtures/model-http.ts";
import { ModelEventWait, isModelStreamEvent } from "../src/durable/model-wait-policy.ts";

it("renews only live event waits and never revives a completed or expired wait", async () => {
  vi.useFakeTimers();
  try {
    const expire = vi.fn(),
      wait = new ModelEventWait(300000, expire);
    expect(isModelStreamEvent({ type: "response.in_progress" })).toBe(true);
    expect(isModelStreamEvent({})).toBe(false);
    expect(isModelStreamEvent({ type: "ping" })).toBe(false);
    expect(isModelStreamEvent(": heartbeat")).toBe(false);
    await vi.advanceTimersByTimeAsync(299999);
    wait.touch();
    await vi.advanceTimersByTimeAsync(299999);
    expect(expire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(expire).toHaveBeenCalledOnce();
    wait.touch();
    await vi.advanceTimersByTimeAsync(600000);
    expect(expire).toHaveBeenCalledOnce();
    const completed = new ModelEventWait(100, expire);
    completed.close();
    completed.touch();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});

it.each(["openai-codex", "deepseek"] as const)(
  "native Pi retries missing first-event timeout on %s",
  async (provider) => {
    const f = await modelHttpFixture(
      provider,
      async (attempt, signal) => {
        if (attempt > 1) return success();
        return new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("fixture request aborted")), {
            once: true,
          });
        });
      },
      { eventIdleTimeoutMs: 250 },
    );
    const { harness, root } = await f.harness();
    try {
      const input = await root.submit(
        { type: "input", content: "wait fixture" },
        BACKGROUND_CONTEXT,
      );
      expect((await input.wait(BACKGROUND_CONTEXT)).status).toBe("done");
      expect(f.payloads).toHaveLength(2);
      expect(f.outcomes.map((x) => x.outcome)).toEqual(["error", "completed"]);
      expect(f.releases()).toBe(2);
    } finally {
      await harness.close(BACKGROUND_CONTEXT);
      await f.close();
    }
  },
);

it.each(["openai-codex", "deepseek"] as const)(
  "non-text provider events keep a long %s response alive",
  async (provider) => {
    const timers: NodeJS.Timeout[] = [];
    const f = await modelHttpFixture(
      provider,
      (_attempt, signal) => {
        const stream = controlled(signal);
        stream.send(created);
        for (let i = 1; i <= 6; i++)
          timers.push(
            setTimeout(
              () =>
                stream.send({
                  type: "response.in_progress",
                  response: { id: "response-1", status: "in_progress" },
                }),
              i * 100,
            ),
          );
        timers.push(
          setTimeout(() => {
            const item = textItem("final", "final_answer", "done");
            stream.send(
              added(textItem("final", "final_answer"), 0),
              delta(0, "done"),
              done(item, 0),
              terminal([item]),
            );
            stream.end();
          }, 700),
        );
        signal.addEventListener("abort", () => timers.forEach(clearTimeout), { once: true });
        return stream.response;
      },
      { eventIdleTimeoutMs: 250 },
    );
    try {
      expect((await f.run()).result.stopReason).toBe("stop");
      expect(f.payloads).toHaveLength(1);
      expect(f.releases()).toBe(1);
    } finally {
      timers.forEach(clearTimeout);
      await f.close();
    }
  },
);

it.each(["openai-codex", "deepseek"] as const)(
  "SSE comments cannot mask %s model inactivity",
  async (provider) => {
    let timer: NodeJS.Timeout | undefined;
    const f = await modelHttpFixture(
      provider,
      (_attempt, signal) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              timer = setInterval(
                () => controller.enqueue(new TextEncoder().encode(": alive\n\n")),
                30,
              );
              signal.addEventListener(
                "abort",
                () => {
                  clearInterval(timer);
                  controller.error(new Error("stopped"));
                },
                { once: true },
              );
            },
            cancel() {
              clearInterval(timer);
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
      { eventIdleTimeoutMs: 250 },
    );
    try {
      const { result } = await f.run();
      expect(result.stopReason).toBe("error");
      expect(result.errorMessage).toContain("event idle timeout");
      expect(f.releases()).toBe(1);
    } finally {
      clearInterval(timer);
      await f.close();
    }
  },
);

it.each(["openai-codex", "deepseek"] as const)(
  "owner Stop during %s first-event waiting is cancellation",
  async (provider) => {
    const entered = Promise.withResolvers<void>();
    const f = await modelHttpFixture(
      provider,
      (_attempt, signal) => {
        const stream = controlled(signal);
        entered.resolve();
        return stream.response;
      },
      { eventIdleTimeoutMs: 5000 },
    );
    try {
      const running = f.run();
      await entered.promise;
      f.owner.abort();
      expect((await running).result.stopReason).toBe("aborted");
      expect(f.payloads).toHaveLength(1);
      expect(f.releases()).toBe(1);
    } finally {
      await f.close();
    }
  },
);
