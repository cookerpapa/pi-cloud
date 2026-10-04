import { expect, it } from "vitest";
import { InMemorySessionRepo } from "@earendil-works/pi-agent-core";
import {
  EventStream,
  type Models,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  type Api,
  type SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { CloudAgentRuntime } from "../packages/sandbox-supervisor/src/cloud-agent-runtime.ts";
import { mergeProviderServiceTier } from "../packages/sandbox-supervisor/src/provider-hosted-tools.ts";

const model = {
  id: "gpt-6-luna",
  name: "Synthetic Luna",
  api: "openai-codex-responses",
  provider: "openai-codex",
  baseUrl: "http://127.0.0.1:1",
  reasoning: false,
  input: ["text"],
  contextWindow: 256,
  maxTokens: 64,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as Model<Api>;
function assistant(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    stopReason: "stop",
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
it("characterizes Fast policy applied to ordinary sampling but omitted from native compaction", async () => {
  const requests: Array<{ purpose: string; tier: unknown }> = [];
  async function payload(purpose: string, options?: SimpleStreamOptions) {
    const body = { model: model.id, stream: true };
    const value = (await options?.onPayload?.(body, model)) ?? body;
    requests.push({ purpose, tier: (value as Record<string, unknown>).service_tier ?? null });
    return value as Record<string, unknown>;
  }
  for (const purpose of ["sampling", "compaction"]) {
    const session = await new InMemorySessionRepo().create();
    if (purpose === "compaction")
      for (let i = 0; i < 4; i++) {
        await session.appendMessage({
          role: "user",
          content: "old ".repeat(300),
          timestamp: Date.now(),
        });
        await session.appendMessage({
          ...assistant("old response"),
          usage: { ...assistant("").usage, input: 50000, totalTokens: 50001 },
        });
      }
    const runtime = new CloudAgentRuntime({
      session,
      lane: "main",
      authority: {
        signal: new AbortController().signal,
        assertCurrent: async () => {},
        close: async () => {},
      },
      model,
      systemPrompt: "review",
      streamOptions: { onPayload: (value) => mergeProviderServiceTier(value, "fast") },
      retry: { enabled: false, maxRetries: 0, baseDelayMs: 1 },
      compaction: { enabled: purpose === "compaction", reserveTokens: 32, keepRecentTokens: 32 },
      streamFn: async (_model, _context, options) => {
        await payload("sampling", options);
        const stream = new EventStream<AssistantMessageEvent, AssistantMessage>(
          (e) => e.type === "done" || e.type === "error",
          (e) => (e.type === "done" ? e.message : (e as { error: AssistantMessage }).error),
        );
        queueMicrotask(() =>
          stream.push({ type: "done", reason: "stop", message: assistant("done") }),
        );
        return stream;
      },
      models: {
        completeSimple: async (
          _model: unknown,
          _context: unknown,
          options?: SimpleStreamOptions,
        ) => {
          const body = await payload("compaction", options);
          return body.service_tier === "fast"
            ? assistant("summary")
            : {
                ...assistant(""),
                stopReason: "error",
                errorMessage: "403 model_service_tier_mismatch",
              };
        },
      } as unknown as Models,
    });
    if (purpose === "sampling") expect((await runtime.run("hello")).kind).toBe("completed");
    else {
      await expect(runtime.run("continue")).resolves.toMatchObject({
        kind: "failed",
        error: { message: expect.stringContaining("model_service_tier_mismatch") },
      });
      expect(await session.findEntries({ type: "compaction" })).toHaveLength(0);
    }
  }
  expect(requests).toEqual([
    { purpose: "sampling", tier: "fast" },
    { purpose: "compaction", tier: null },
  ]);
});
