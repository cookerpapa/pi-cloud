import { expect, it } from "vitest";
import type { AssistantMessage, AssistantMessageEvent, TextContent } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import { CloudModelRegistry } from "../src/durable/model-registry.ts";
import { ProviderResponse, providerTextPhase } from "../src/durable/provider-response.ts";
import { isHostedToolBlock } from "../src/provider-hosted-transcript.ts";
const model = new CloudModelRegistry().configure({
  provider: "openai-codex",
  modelId: "gpt-6-luna",
  api: "openai-codex-responses",
  baseUrl: "http://unused.test",
  apiKey: "test",
});
const message = (content: AssistantMessage["content"] = []): AssistantMessage => ({
  ...fauxAssistantMessage(content, { stopReason: "pending" }),
  provider: model.provider,
  model: model.id,
  api: model.api,
  responseId: "response-1",
});
const item = (id: string, type: string, phase?: string) => ({
  id,
  type,
  ...(phase ? { phase } : {}),
});
const added = (value: unknown) => ({ type: "response.output_item.added", item: value });
const search = (id: string) => ({
  id,
  type: "web_search_call",
  status: "completed",
  action: { type: "search", query: "source" },
});

it("associates early phases with actual text slots after reasoning and Tool placeholders", () => {
  const events: AssistantMessageEvent[] = [];
  const state = new ProviderResponse(model, (e) => events.push(e));
  state.progress({ type: "start", partial: message() });
  state.observe(added(item("reason", "reasoning")));
  state.observe(added(item("comment", "message", "commentary")));
  state.observe(added(item("call", "function_call")));
  state.observe(added(item("final", "message", "final_answer")));
  const partial = message([
    { type: "thinking", thinking: "plan" },
    { type: "text", text: "checking" },
    fauxToolCall("bash", { command: "PRIVATE_DRAFT" }, { id: "call|fc_1" }),
    { type: "text", text: "done" },
  ]);
  state.progress({ type: "text_delta", contentIndex: 3, delta: "done", partial });
  const current = (events.at(-1)! as { partial: AssistantMessage }).partial;
  expect(current.content[2]).toEqual({ type: "text", text: "" });
  expect(providerTextPhase(current.content[1] as TextContent)).toBe("commentary");
  expect(providerTextPhase(current.content[3] as TextContent)).toBe("final_answer");
  expect(JSON.stringify(events)).not.toContain("PRIVATE_DRAFT");
  (partial.content[1] as TextContent).text = "later mutation";
  expect(current.content[1]).toMatchObject({ text: "checking" });
  state.close("failed");
});

it("emits completed hosted-only content through valid empty text progress without waiting for another token", () => {
  const events: AssistantMessageEvent[] = [];
  const state = new ProviderResponse(model, (e) => events.push(e));
  state.progress({ type: "start", partial: message() });
  state.observe(added(search("search-1")));
  state.observe({ type: "response.output_item.done", item: search("search-1") });
  expect(events.map((e) => e.type)).toEqual(["start", "text_start", "text_end"]);
  const snapshot = (events.at(-1)! as { partial: AssistantMessage }).partial;
  expect(snapshot.content).toHaveLength(1);
  expect(isHostedToolBlock(snapshot.content[0])).toBe(true);
  expect(snapshot.content[0]).toMatchObject({
    type: "text",
    text: "",
    providerHostedTool: { nativeItem: search("search-1") },
  });
  const final = state.result({
    ...message(),
    stopReason: "error",
    errorMessage: "connection error",
  });
  expect(final.content).toEqual(snapshot.content);
  state.observe({ type: "response.output_item.done", item: search("late") });
  expect(events).toHaveLength(3);
});

it("keeps text positions stable around a hosted carrier and deduplicates item completion", () => {
  const events: AssistantMessageEvent[] = [];
  const state = new ProviderResponse(model, (e) => events.push(e));
  state.progress({ type: "start", partial: message() });
  state.observe(added(item("before", "message", "commentary")));
  state.progress({
    type: "text_start",
    contentIndex: 0,
    partial: message([{ type: "text", text: "" }]),
  });
  state.progress({
    type: "text_delta",
    contentIndex: 0,
    delta: "before",
    partial: message([{ type: "text", text: "before" }]),
  });
  state.observe(added(search("search-1")));
  state.observe({ type: "response.output_item.done", item: search("search-1") });
  state.observe(added(item("after", "message", "final_answer")));
  const partial = message([
    { type: "text", text: "before" },
    { type: "text", text: "after" },
  ]);
  state.progress({ type: "text_delta", contentIndex: 1, delta: "after", partial });
  const delta = events.at(-1)!;
  expect(delta).toMatchObject({ type: "text_delta", contentIndex: 2 });
  const count = events.length;
  state.observe({ type: "response.completed", response: { output: [search("search-1")] } });
  expect(events).toHaveLength(count);
  const final = state.result({ ...partial, stopReason: "stop" });
  expect(final.content.map((b) => (b.type === "text" ? b.text : "other"))).toEqual([
    "before",
    "",
    "after",
  ]);
  expect(final.content.filter(isHostedToolBlock)).toHaveLength(1);
});

it("keeps DeepSeek phase unknown until its authoritative completion and isolates hook failures", () => {
  const events: AssistantMessageEvent[] = [];
  const state = new ProviderResponse(
    { ...model, provider: "deepseek" },
    (e) => events.push(e),
    () => {
      throw new Error("lost observation");
    },
  );
  state.progress({ type: "start", partial: message() });
  state.observe(added(item("t", "message", "final_answer")));
  state.progress({
    type: "text_delta",
    contentIndex: 0,
    delta: "checking",
    partial: message([{ type: "text", text: "checking" }]),
  });
  expect(
    providerTextPhase(
      (events.at(-1)! as { partial: AssistantMessage }).partial.content[0] as TextContent,
    ),
  ).toBeUndefined();
  state.observe({ type: "response.output_item.done", item: item("t", "message", "commentary") });
  state.observe({ type: "response.output_item.done", item: search("s") });
  const result = state.result({
    ...message([{ type: "text", text: "checking" }]),
    stopReason: "stop",
  });
  expect(providerTextPhase(result.content[0] as TextContent)).toBe("commentary");
});
