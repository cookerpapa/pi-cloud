import { afterEach, expect, it, vi } from "vitest";
import { ownershipRetirement } from "../src/ownership-retirement.ts";

afterEach(() => vi.useRealTimers());

it("waits for startup acquisition, then closes once and retains bounded exit", async () => {
  vi.useFakeTimers();
  const startup = Promise.withResolvers<void>();
  const close = vi.fn(async () => {}),
    fail = vi.fn(),
    exit = vi.fn(),
    cleanupFailed = vi.fn();
  const retire = ownershipRetirement({
    startupSettled: startup.promise,
    close,
    fail,
    exit,
    cleanupFailed,
  });
  retire();
  retire();
  expect(fail).toHaveBeenCalledOnce();
  expect(close).not.toHaveBeenCalled();
  startup.resolve();
  await vi.advanceTimersByTimeAsync(1);
  expect(close).toHaveBeenCalledOnce();
  expect(cleanupFailed).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(exit).toHaveBeenCalledOnce();
});

it.each(["startup", "close", "failure"])("exits after a stuck or failed %s", async (stage) => {
  vi.useFakeTimers();
  const forever = new Promise<void>(() => {});
  const exit = vi.fn(),
    cleanupFailed = vi.fn();
  const retire = ownershipRetirement({
    startupSettled: stage === "startup" ? forever : Promise.resolve(),
    close: () => (stage === "close" ? forever : Promise.reject(new Error("private detail"))),
    fail: () => {},
    exit,
    cleanupFailed,
  });
  retire();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(exit).toHaveBeenCalledOnce();
  expect(cleanupFailed).toHaveBeenCalledTimes(stage === "failure" ? 1 : 0);
});
