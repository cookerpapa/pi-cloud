import { expect, it, vi } from "vitest";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { DurableAgentSession } from "../src/durable/agent-session.ts";
import { mergeProviderServiceTier } from "../src/provider-hosted-tools.ts";

it.each(["fast", null] as const)(
  "carries %s request policy through native compaction and sampling",
  async (tier) => {
    const provider = fauxProvider({ tokensPerSecond: 1000000 }),
      models = createModels();
    models.setProvider(provider.provider);
    provider.setResponses([
      fauxAssistantMessage("Condensed prior work"),
      fauxAssistantMessage("done"),
    ]);
    const requests: Array<{
      purpose: string;
      tier: unknown;
      timeout: unknown;
      transport: unknown;
    }> = [];
    let purpose = "";
    const stream = models.streamSimple.bind(models);
    vi.spyOn(models, "streamSimple").mockImplementation((model, context, options) => {
      requests.push({
        purpose,
        tier: options?.onPayload?.({}, model),
        timeout: options?.timeoutMs,
        transport: options?.transport,
      });
      return stream(model, context, options);
    });
    const model = { ...provider.getModel(), contextWindow: 1024, maxTokens: 128 };
    const runtime = await DurableAgentSession.open(new MemoryStorage(), {
      models,
      remoteTools: [],
      settings: {
        stream: { timeoutMs: 4321, transport: "sse" },
        retry: { maxRetries: 0 },
        compaction: { enabled: true, reserveTokens: 128, keepRecentTokens: 64 },
      },
    });
    try {
      const root = await runtime.bind({
        runId: crypto.randomUUID(),
        conversationId: 1,
        model,
        agent: {},
        context: {},
        tools: [],
        remoteTools: () => [],
        assertCurrent: async () => {},
        prepareRemote: async () => {
          throw new Error("No effect expected");
        },
        openModel: async (request, native) => {
          purpose = native!.purpose;
          return {
            model,
            options: {
              ...request.options,
              onPayload: (payload: unknown) => mergeProviderServiceTier(payload, tier),
            },
            release: () => {},
          };
        },
      });
      await root.commit(async (tx) => {
        for (let index = 0; index < 5; index++) {
          await tx.appendEntry(root.id, {
            kind: "pi.user",
            model: [{ role: "user", content: "old context ".repeat(400), timestamp: index }],
          });
          await tx.appendEntry(root.id, {
            kind: "pi.assistant",
            model: [fauxAssistantMessage("old answer")],
          });
        }
      }, BACKGROUND_CONTEXT);
      const submitted = await root.submit(
        { type: "input", content: "continue" },
        BACKGROUND_CONTEXT,
      );
      expect((await submitted.wait(BACKGROUND_CONTEXT)).status).toBe("done");
      expect(requests.map((request) => request.purpose)).toEqual(["context_maintenance", "agent"]);
      expect(
        requests.every((request) => request.timeout === 0 && request.transport === "sse"),
      ).toBe(true);
      expect(await Promise.all(requests.map((request) => Promise.resolve(request.tier)))).toEqual(
        requests.map(() => (tier ? { service_tier: "fast" } : {})),
      );
      expect(
        (await root.entries({}, 100, undefined, BACKGROUND_CONTEXT)).items.some(
          (entry) => entry.kind === "pi.compaction",
        ),
      ).toBe(true);
    } finally {
      await runtime.close();
    }
  },
);
