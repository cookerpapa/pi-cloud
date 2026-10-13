import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { ScopedDurableModels } from "../src/durable/scoped-models.ts";

describe("Durable model calls under cloud authority", () => {
  it("binds concurrent conversations to their own grants without persisting credentials", async () => {
    const base = createModels(),
      faux = fauxProvider({ tokensPerSecond: 1_000_000 });
    base.setProvider(faux.provider);
    const leases: string[] = [],
      releases: string[] = [];
    const router = new ScopedDurableModels(base, async ({ runId, conversationId, options }) => {
      leases.push(`${runId}:${conversationId}`);
      return {
        model: faux.getModel(),
        options: { ...options, apiKey: `private-${runId}` },
        release: () => {
          releases.push(`${runId}:${conversationId}`);
        },
      };
    });
    const rootRun = randomUUID();
    const a = router.register(rootRun, 1, {
      ...faux.getModel(),
      headers: { Authorization: "must not persist" },
    });
    const b = router.register(rootRun, 17, faux.getModel());
    const modelA = router.models.getModel(a.provider, a.modelId)!,
      modelB = router.models.getModel(b.provider, b.modelId)!;
    expect(JSON.stringify(modelA)).not.toContain("must not persist");
    expect(JSON.stringify(a)).not.toContain("private");
    faux.setResponses([fauxAssistantMessage("A"), fauxAssistantMessage("B")]);
    const results = await Promise.all([
      router.models.completeSimple(modelA, { messages: [] }),
      router.models.completeSimple(modelB, { messages: [] }),
    ]);
    expect(results.every((result) => result.model === faux.getModel().id)).toBe(true);
    expect(new Set(leases)).toEqual(new Set([`${rootRun}:1`, `${rootRun}:17`]));
    expect(new Set(releases)).toEqual(new Set(leases));
  });

  it("refuses model and compaction calls at the Models port without entering the provider", async () => {
    const base = createModels(),
      faux = fauxProvider();
    base.setProvider(faux.provider);
    const open = vi.fn(async () => {
      throw new Error("revoked: private-token");
    });
    const router = new ScopedDurableModels(base, open),
      route = router.register(randomUUID(), 1, faux.getModel());
    const model = router.models.getModel(route.provider, route.modelId)!;
    expect((await router.models.streamSimple(model, { messages: [] }).result()).stopReason).toBe(
      "error",
    );
    const compaction = await router.models.completeSimple(model, { messages: [] });
    expect(compaction.stopReason).toBe("error");
    expect(JSON.stringify(compaction)).not.toContain("private-token");
    expect(faux.state.callCount).toBe(0);
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("releases an acquired permit when cancellation wins before provider dispatch", async () => {
    const base = createModels(),
      faux = fauxProvider();
    base.setProvider(faux.provider);
    const abort = new AbortController(),
      release = vi.fn();
    const router = new ScopedDurableModels(base, async ({ options }) => {
      abort.abort();
      return { model: faux.getModel(), options, release };
    });
    const route = router.register(randomUUID(), 1, faux.getModel()),
      model = router.models.getModel(route.provider, route.modelId)!;
    expect(
      (await router.models.completeSimple(model, { messages: [] }, { signal: abort.signal }))
        .stopReason,
    ).toBe("aborted");
    expect(release).toHaveBeenCalledOnce();
    expect(faux.state.callCount).toBe(0);
  });
});
