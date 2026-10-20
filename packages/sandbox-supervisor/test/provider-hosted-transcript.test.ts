import { describe, expect, it } from "vitest";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { CloudModelRegistry } from "../src/durable/model-registry.ts";
import {
  hostedSearchContent,
  isHostedToolBlock,
  nativeProviderContext,
  replayProviderHostedTranscripts,
} from "../src/provider-hosted-transcript.ts";
const model = new CloudModelRegistry().configure({
  provider: "openai-codex",
  modelId: "gpt-6-luna",
  api: "openai-codex-responses",
  baseUrl: "http://unused.test",
  apiKey: "test",
});
const search = (id: string) => ({
  type: "web_search_call",
  id,
  status: "completed",
  action: { type: "search", query: "source" },
});
describe("native hosted progress and replay", () => {
  it("keeps one stable opaque carrier identity across terminal metadata updates", () => {
    const first = hostedSearchContent(search("search-1"));
    const next = hostedSearchContent(
      { ...search("search-1"), action: { type: "open_page", url: "https://example.test" } },
      first,
    );
    expect(first.text).toBe("");
    expect(next.textSignature).toBe(first.textSignature);
    expect(first.providerHostedTool.nativeItem.action).toEqual({ type: "search", query: "source" });
    expect(isHostedToolBlock(next)).toBe(true);
  });
  it.each([false, true])(
    "replaces exact native placeholder positions, including hosted-only=%s",
    (only) => {
      const carriers = [
        hostedSearchContent(search("search-1")),
        hostedSearchContent(search("search-2")),
      ];
      const text = {
        type: "text" as const,
        text: "answer",
        textSignature: JSON.stringify({ v: 1, id: "message-1" }),
        providerAnnotations: [{ type: "url_citation", url: "https://example.test" }],
      };
      const message = {
        ...fauxAssistantMessage([...carriers, ...(only ? [] : [text])]),
        provider: model.provider,
        model: model.id,
        api: model.api,
      };
      const payload = {
        input: [
          { type: "message", role: "user", content: "before" },
          ...message.content.map((b) => ({
            type: "message",
            id: JSON.parse((b as typeof text).textSignature).id,
            content: [{ type: "output_text", text: (b as typeof text).text }],
          })),
          { type: "message", role: "user", content: "after" },
        ],
      };
      const replayed = replayProviderHostedTranscripts(
        payload,
        { messages: [message] },
        model,
      ) as typeof payload;
      expect(replayed.input.map((i) => i.type)).toEqual([
        "message",
        "web_search_call",
        "web_search_call",
        ...(only ? [] : ["message"]),
        "message",
      ]);
      expect(JSON.stringify(replayed)).not.toContain("msg_picloud_hosted_");
      if (!only)
        expect((replayed.input[3]!.content as unknown[])[0]).toMatchObject({
          annotations: text.providerAnnotations,
        });
      expect(replayed.input.at(-1)).toEqual({ type: "message", role: "user", content: "after" });
    },
  );
  it("removes hosted carriers before cross-model encoding and preserves ordinary text", () => {
    const original = {
      ...fauxAssistantMessage([hostedSearchContent(search("s")), { type: "text", text: "answer" }]),
      provider: model.provider,
      model: model.id,
      api: model.api,
    };
    const same = nativeProviderContext({ messages: [original] }, model);
    expect(same.messages[0]).toBe(original);
    const other = nativeProviderContext({ messages: [original] }, { ...model, id: "gpt-6-sol" });
    expect(other.messages[0]!.content).toEqual([{ type: "text", text: "answer" }]);
    const only = { ...original, content: [original.content[0]!] };
    expect(
      nativeProviderContext({ messages: [only] }, { ...model, provider: "deepseek" }).messages,
    ).toEqual([]);
  });
});
