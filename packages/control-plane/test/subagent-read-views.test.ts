import { expect, it, vi } from "vitest";
import { SubagentReadViews } from "../src/subagent-read-views.ts";

it("shares warm lookups and rejects late cache installation after a family change", async () => {
  const views = new SubagentReadViews(),
    first = Promise.withResolvers<string>();
  const load = vi.fn(() => first.promise);
  const a = views.read("family", "status", load),
    b = views.read("family", "status", load);
  await Promise.resolve();
  expect(load).toHaveBeenCalledOnce();
  views.invalidate("family");
  const current = vi.fn(async () => "completed");
  expect(await views.read("family", "status", current)).toBe("completed");
  first.resolve("running");
  await Promise.all([a, b]);
  for (let i = 0; i < 100; i++)
    expect(await views.read("family", "status", current)).toBe("completed");
  expect(current).toHaveBeenCalledOnce();
  views.reset();
  await views.read("family", "status", current);
  expect(current).toHaveBeenCalledTimes(2);
});

it("does not retain failed or over-budget values and isolates Session families", async () => {
  const views = new SubagentReadViews(2, 16);
  const failure = vi.fn(async () => {
    throw new Error("read unavailable");
  });
  await expect(views.read("one", "key", failure)).rejects.toThrow("unavailable");
  const load = vi.fn(async () => "x".repeat(100));
  await views.read("one", "key", load);
  await views.read("one", "key", load);
  expect(load).toHaveBeenCalledTimes(2);
  expect(await views.read("two", "key", async () => "other")).toBe("other");
});
