import { describe, expect, it } from "vitest";
import { stream } from "@earendil-works/pi-ai/api/openai-responses";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { AssistantTextPresentation } from "../src/assistant-text-presentation.ts";
import { ResponsesHostedActivityObserver } from "../../supervisor-host/src/responses-hosted-activity.ts";
import type { AssistantMessagePhase } from "@pi-cloud/protocol";

const model: Model<"openai-responses"> = {
  id: "fixture",
  name: "Fixture",
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://provider.invalid/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 10000,
  maxTokens: 1000,
};
function item(id: string, phase: AssistantMessagePhase, text: string) {
  return {
    id,
    type: "message",
    role: "assistant",
    phase,
    content: [{ type: "output_text", text, annotations: [] }],
    status: "completed",
  };
}

describe("assistant text presentation", () => {
  it("uses real Pi Responses text_start order despite reasoning/search slots, and preserves native signatures", async () => {
    const intro = item("m1", "commentary", "I will inspect."),
      final = item("m2", "final_answer", "All done.");
    const events = [
      { type: "response.created", response: { id: "response-1" } },
      {
        type: "response.output_item.added",
        output_index: 0,
        item: { type: "reasoning", id: "r1", summary: [] },
      },
      {
        type: "response.output_item.done",
        output_index: 0,
        item: { type: "reasoning", id: "r1", summary: [] },
      },
      { type: "response.output_item.added", output_index: 1, item: { ...intro, content: [] } },
      { type: "response.output_text.delta", output_index: 1, delta: "I will " },
      { type: "response.output_text.delta", output_index: 1, delta: "inspect." },
      { type: "response.output_item.done", output_index: 1, item: intro },
      {
        type: "response.output_item.added",
        output_index: 2,
        item: { type: "web_search_call", id: "w1" },
      },
      {
        type: "response.output_item.done",
        output_index: 2,
        item: { type: "web_search_call", id: "w1", status: "completed" },
      },
      { type: "response.output_item.added", output_index: 3, item: { ...final, content: [] } },
      { type: "response.output_text.delta", output_index: 3, delta: "All " },
      { type: "response.output_text.delta", output_index: 3, delta: "done." },
      { type: "response.output_item.done", output_index: 3, item: final },
      {
        type: "response.completed",
        response: {
          id: "response-1",
          status: "completed",
          output: [intro, final],
          usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
        },
      },
    ];
    const phases = new Map<number, AssistantMessagePhase>();
    const observer = new ResponsesHostedActivityObserver(
      () => {},
      undefined,
      undefined,
      (response, index, phase) => {
        expect(response).toBe("response-1");
        if (phase) phases.set(index, phase);
      },
    );
    const presentation = new AssistantTextPresentation((response, index) => {
      expect(response).toBe("response-1");
      return phases.get(index);
    });
    const body = new TextEncoder().encode(
      events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""),
    );
    const response = stream(
      model,
      { messages: [{ role: "user", content: "test", timestamp: 1 }] },
      {
        apiKey: "fixture",
        fetch: async () => {
          // Same ordering as Gateway: observe complete SSE frames before forwarding bytes.
          for (let n = 0; n < body.length; n += 7) observer.push(body.subarray(n, n + 7));
          return new Response(body, { headers: { "content-type": "text/event-stream" } });
        },
      },
    );
    const visible: unknown[] = [];
    for await (const e of response) {
      if (e.type === "start") presentation.present({ type: "message_start", message: e.partial });
      if (e.type === "done" || e.type === "error" || e.type === "start") continue;
      const shown = presentation.present({
        type: "message_update",
        message: e.partial,
        assistantMessageEvent: e,
      });
      if (e.type === "text_delta" && e.contentIndex === 1) expect(shown).toBeUndefined();
      if (shown?.type === "message_update" && shown.assistantMessageEvent.type === "text_delta")
        visible.push({
          text: shown.assistantMessageEvent.delta,
          phase:
            "presentationPhase" in shown.assistantMessageEvent
              ? shown.assistantMessageEvent.presentationPhase
              : undefined,
        });
    }
    expect(visible).toEqual([
      { text: "I will inspect.", phase: "commentary" },
      { text: "All ", phase: "final_answer" },
      { text: "done.", phase: "final_answer" },
    ]);
    const completed = await response.result();
    expect(completed.stopReason).toBe("stop");
    expect(
      completed.content.filter((c) => c.type === "text").map((c) => JSON.parse(c.textSignature!)),
    ).toEqual([
      { v: 1, id: "m1", phase: "commentary" },
      { v: 1, id: "m2", phase: "final_answer" },
    ]);
  });

  it("does not invent output when commentary is interrupted, and resets metadata at the next response", () => {
    const p = new AssistantTextPresentation((id) => (id === "first" ? "commentary" : undefined));
    const partial: AssistantMessage = {
      role: "assistant",
      content: [],
      api: "openai-responses",
      provider: "openai",
      model: "fixture",
      stopReason: "stop",
      timestamp: 1,
      responseId: "first",
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    p.present({ type: "message_start", message: partial });
    p.present({
      type: "message_update",
      message: partial,
      assistantMessageEvent: { type: "text_start", contentIndex: 0, partial },
    });
    const delta = {
      type: "message_update" as const,
      message: partial,
      assistantMessageEvent: {
        type: "text_delta" as const,
        contentIndex: 0,
        delta: "unseen partial",
        partial,
      },
    };
    expect(p.present(delta)).toBeUndefined();
    const failure = {
      type: "message_end" as const,
      message: { ...partial, stopReason: "aborted" as const },
    };
    expect(p.present(failure)).toBe(failure);
    const next = { ...partial, responseId: "next" };
    p.present({ type: "message_start", message: next });
    p.present({
      type: "message_update",
      message: next,
      assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: next },
    });
    const nextDelta = {
      ...delta,
      message: next,
      assistantMessageEvent: { ...delta.assistantMessageEvent, partial: next },
    };
    expect(p.present(nextDelta)).toBe(nextDelta);
  });
});
