import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { ScopedDurableModels } from "../src/durable/scoped-models.ts";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";

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

it("times SDK preparation before HTTP while preserving payload/fetch hooks and ignoring logging failure", async () => {
  const base = createModels(),
    faux = fauxProvider();
  base.setProvider(faux.provider);
  const dispatched = Promise.withResolvers<void>(),
    response = Promise.withResolvers<void>();
  const payload = { private: "original" },
    replaced = { private: "replacement" };
  const onPayload = vi.fn(async () => replaced),
    fetcher = vi.fn(async () => new Response("ok"));
  const prepared = vi.fn((_sample: unknown) => {
      throw Error("diagnostic sink failed");
    }),
    release = vi.fn();
  vi.spyOn(base, "streamSimple").mockImplementation((model, _input, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      const value = await options!.onPayload!(payload, model);
      expect(value).toBe(replaced);
      await options!.fetch!("http://example.invalid", {
        method: "POST",
        body: JSON.stringify(value),
        ...(options!.signal ? { signal: options!.signal } : {}),
      });
      dispatched.resolve();
      await response.promise;
      const message = fauxAssistantMessage("done");
      stream.push({ type: "done", reason: "stop", message });
      stream.end(message);
    })();
    return stream;
  });
  const scoped = new ScopedDurableModels(base, async (request) => ({
    model: faux.getModel(),
    options: { ...request.options, onPayload, fetch: fetcher },
    onPrepared: prepared,
    release,
  }));
  const route = scoped.register(randomUUID(), 1, faux.getModel());
  const result = scoped.models.completeSimple(
    scoped.models.getModel(route.provider, route.modelId)!,
    { messages: [] },
  );
  await dispatched.promise;
  expect(prepared).toHaveBeenCalledOnce();
  expect(prepared.mock.calls[0]).toEqual([
    expect.objectContaining({
      httpDispatched: true,
      outcome: "completed",
      payloadHookMs: expect.any(Number),
      afterPayloadMs: expect.any(Number),
      requestCharacters: JSON.stringify(replaced).length,
    }),
  ]);
  expect(onPayload).toHaveBeenCalledExactlyOnceWith(payload, expect.any(Object));
  expect(fetcher).toHaveBeenCalledOnce();
  expect(JSON.stringify(prepared.mock.calls)).not.toContain("replacement");
  response.resolve();
  expect((await result).stopReason).toBe("stop");
  expect(release).toHaveBeenCalledOnce();
});

it.each([false, true])(
  "records pre-dispatch failure/cancellation (%s) without trying HTTP",
  async (cancelled) => {
    const base = createModels(),
      faux = fauxProvider();
    base.setProvider(faux.provider);
    const abort = new AbortController(),
      prepared = vi.fn(),
      fetcher = vi.fn(),
      release = vi.fn();
    vi.spyOn(base, "streamSimple").mockImplementation((_model, _input, options) => {
      const stream = createAssistantMessageEventStream();
      void (async () => {
        if (cancelled) abort.abort();
        try {
          await options!.onPayload!({}, faux.getModel());
        } catch {
          /* native adapters turn preparation errors into an error result */
        }
        const error = {
          ...fauxAssistantMessage(""),
          stopReason: cancelled ? ("aborted" as const) : ("error" as const),
          errorMessage: "private failure",
        };
        stream.push({ type: "error", reason: error.stopReason, error });
        stream.end(error);
      })();
      return stream;
    });
    const scoped = new ScopedDurableModels(base, async (request) => ({
      model: faux.getModel(),
      options: {
        ...request.options,
        fetch: fetcher,
        onPayload: () => {
          throw Error("private failure");
        },
      },
      onPrepared: prepared,
      release,
    }));
    const route = scoped.register(randomUUID(), 1, faux.getModel());
    await scoped.models.completeSimple(
      scoped.models.getModel(route.provider, route.modelId)!,
      { messages: [] },
      { signal: abort.signal },
    );
    expect(prepared).toHaveBeenCalledOnce();
    expect(prepared.mock.calls[0]?.[0]).toMatchObject({
      httpDispatched: false,
      outcome: cancelled ? "cancelled" : "failed",
    });
    expect(JSON.stringify(prepared.mock.calls)).not.toContain("private failure");
    expect(fetcher).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledOnce();
  },
);

it("a late successful reply cannot overwrite the event inactivity timeout", async () => {
  vi.useFakeTimers();
  try {
    const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai");
    const base = createModels(),
      faux = fauxProvider();
    base.setProvider(faux.provider);
    const release = vi.fn();
    vi.spyOn(base, "streamSimple").mockImplementation(() => {
      const stream = createAssistantMessageEventStream();
      const message = fauxAssistantMessage("late reply");
      setTimeout(() => {
        stream.push({ type: "done", reason: "stop", message });
        stream.end(message);
      }, 50);
      return stream;
    });
    const scoped = new ScopedDurableModels(base, async (request) => ({
      model: faux.getModel(),
      options: request.options,
      eventIdleTimeoutMs: 20,
      release,
    }));
    const route = scoped.register(randomUUID(), 1, faux.getModel());
    const result = scoped.models.completeSimple(
      scoped.models.getModel(route.provider, route.modelId)!,
      { messages: [] },
    );
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toMatchObject({
      stopReason: "error",
      errorMessage: "Model response event idle timeout after 20ms",
    });
    expect(release).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
