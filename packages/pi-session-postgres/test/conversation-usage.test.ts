import { expect, it } from "vitest";
import { nativeUsageTotals, estimateStoredContext } from "../src/durable/conversation-usage.ts";
import type { ImagePacked } from "@pi-cloud/protocol";
import type { EntryRecord } from "@earendil-works/pi-durable";
const usage = {
  input: 20,
  cacheRead: 80,
  cacheWrite: 3,
  output: 7,
  totalTokens: 110,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
it("counts cache input once and includes reported tool usage", () => {
  const result = nativeUsageTotals({
    models: { "provider/model": usage },
    tools: { inference: usage },
  });
  expect(result.tokens).toEqual({
    input: 206,
    output: 14,
    cacheRead: 160,
    cacheWrite: 6,
    total: 220,
  });
  expect(result.models[0]?.tokens.total).toBe(110);
});
it("invalidates old usage at compaction placement even if its timestamp is later", () => {
  const entries = [
    { id: 3, kind: "pi.user", model: [{ role: "user", content: "kept", timestamp: 30 }] },
    {
      id: 5,
      kind: "pi.assistant",
      model: [
        {
          role: "assistant",
          provider: "provider",
          model: "model",
          api: "openai-responses",
          content: [{ type: "text", text: "answer" }],
          stopReason: "stop",
          timestamp: 50,
          usage,
        },
      ],
    },
    {
      id: 6,
      kind: "pi.compaction",
      head: 3,
      model: [{ role: "user", content: "summary", timestamp: 40 }],
    },
  ] as unknown as ImagePacked<EntryRecord>[];
  const compacted = estimateStoredContext(entries, { provider: "provider", modelId: "model" });
  expect(compacted.method).toBe("structural");
  expect(compacted.estimatedTokens).toBeLessThan(110);
  const later = { ...entries[1]!, id: 7 } as ImagePacked<EntryRecord>;
  expect(
    estimateStoredContext([...entries, later], { provider: "provider", modelId: "model" }),
  ).toEqual({ method: "latest_usage", estimatedTokens: 110 });
  expect(
    estimateStoredContext([...entries, later], { provider: "provider", modelId: "another" }).method,
  ).toBe("structural");
});
