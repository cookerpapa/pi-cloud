import { describe, expect, it } from "vitest";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ProviderHostedTranscript } from "../src/agent-turn-runtime.ts";
import {
  applyProviderHostedTranscript,
  replayProviderHostedTranscripts,
} from "../src/provider-hosted-transcript.ts";

function assistant(): AssistantMessage {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    content: [
      {
        type: "thinking",
        thinking: "searched",
        thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs-1" }),
      },
      {
        type: "text",
        text: "The cited answer",
        textSignature: JSON.stringify({ v: 1, id: "msg-1" }),
      },
    ],
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: 1,
  };
}

const transcript: ProviderHostedTranscript = {
  provider: "deepseek",
  api: "openai-responses",
  modelId: "deepseek-v4-flash",
  stepSequence: 1,
  stepSha256: "a".repeat(64),
  samplingAttempt: 1,
  items: [
    { outputIndex: 0, type: "reasoning", id: "rs-1" },
    {
      outputIndex: 1,
      type: "web_search_call",
      id: "ws-1",
      nativeItem: {
        type: "web_search_call",
        id: "ws-1",
        status: "completed",
        action: { type: "search", query: "official source" },
      },
    },
    {
      outputIndex: 2,
      type: "message",
      id: "msg-1",
      annotations: [
        {
          type: "url_citation",
          start_index: 4,
          end_index: 9,
          title: "Source",
          url: "https://example.test/source",
        },
      ],
    },
  ],
};

const model = {
  provider: "deepseek",
  id: "deepseek-v4-flash",
  api: "openai-responses",
} as Model<"openai-responses">;

describe("Provider Hosted transcript", () => {
  it.each([false, true])("preserves adjacent search order with trailing=%s", (trailing) => {
    const message = assistant();
    if (trailing) message.content.splice(1);
    const secondSearch = {
      ...transcript.items[1]!,
      outputIndex: 2,
      id: "ws-2",
      nativeItem: { ...transcript.items[1]!.nativeItem!, id: "ws-2" },
    };
    applyProviderHostedTranscript(message, {
      ...transcript,
      items: [
        transcript.items[0]!,
        transcript.items[1]!,
        secondSearch,
        ...(trailing ? [] : [{ ...transcript.items[2]!, outputIndex: 3 }]),
      ],
    });
    const payload = {
      input: [
        { type: "reasoning", id: "rs-1" },
        ...(trailing ? [] : [{ type: "message", id: "msg-1" }]),
      ],
    };
    for (let replay = 0; replay < 2; replay++) {
      replayProviderHostedTranscripts(payload, { messages: [message] }, model);
      expect(payload.input.map((item) => item.id)).toEqual([
        "rs-1",
        "ws-1",
        "ws-2",
        ...(trailing ? [] : ["msg-1"]),
      ]);
    }
  });

  it("persists native search order and citation annotations idempotently", () => {
    const message = assistant();
    applyProviderHostedTranscript(message, transcript);
    applyProviderHostedTranscript(message, transcript);

    expect(message.content.map((block) => block.type)).toEqual([
      "thinking",
      "providerHostedToolCall",
      "text",
    ]);
    expect(message.content[1]).toMatchObject({
      action: { type: "search", queries: ["official source"] },
    });
    expect(
      (message.content[2] as unknown as { providerAnnotations: unknown[] }).providerAnnotations,
    ).toHaveLength(1);
  });

  it("replays native items only to the exact issuing model", () => {
    const message = assistant();
    applyProviderHostedTranscript(message, transcript);
    const payload = {
      input: [
        { type: "reasoning", id: "rs-1" },
        {
          type: "message",
          id: "msg-1",
          content: [{ type: "output_text", text: "The cited answer", annotations: [] }],
        },
      ],
    };
    replayProviderHostedTranscripts(payload, { messages: [message] }, model);

    expect(payload.input.map((item) => item.type)).toEqual([
      "reasoning",
      "web_search_call",
      "message",
    ]);
    expect(payload.input[2]?.content?.[0]?.annotations).toHaveLength(1);

    const crossProviderPayload = {
      input: [
        { type: "reasoning", id: "rs-1" },
        { type: "message", id: "msg-1", content: [] },
      ],
    };
    replayProviderHostedTranscripts(crossProviderPayload, { messages: [message] }, {
      provider: "openai-codex",
      id: "gpt-5.6-luna",
      api: "openai-codex-responses",
    } as Model<"openai-codex-responses">);
    expect(crossProviderPayload.input.map((item) => item.type)).toEqual(["reasoning", "message"]);
  });
});
