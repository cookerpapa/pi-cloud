import { expect, it, vi } from "vitest";
import { NativeProjectionProgress } from "../src/native-projection-progress.ts";

it.each([1, 4, 16])(
  "shares one progress read across %s Lanes and reuses confirmed positions",
  async (lanes) => {
    const result = Promise.withResolvers<number>();
    const read = vi.fn(() => result.promise),
      assertCurrent = vi.fn(async () => {});
    const progress = new NativeProjectionProgress({ initialThrough: 0, read, assertCurrent });
    const signal = new AbortController().signal;
    const waits = Array.from({ length: lanes }, (_, i) => progress.wait(i + 1, signal));
    await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
    result.resolve(16);
    await Promise.all(waits);
    await progress.wait(16, signal);
    expect(read).toHaveBeenCalledOnce();
    expect(assertCurrent.mock.calls.length).toBeGreaterThanOrEqual(lanes + 1);
  },
);

it("cancels one waiting Lane immediately without interrupting a sibling's read", async () => {
  const result = Promise.withResolvers<number>();
  const read = vi.fn(() => result.promise);
  const progress = new NativeProjectionProgress({
    initialThrough: 0,
    read,
    assertCurrent: async () => {},
  });
  const abort = new AbortController();
  const cancelled = progress.wait(8, abort.signal);
  const sibling = progress.wait(8, new AbortController().signal);
  await vi.waitFor(() => expect(read).toHaveBeenCalledOnce());
  const rejected = expect(cancelled).rejects.toThrow("cancel only A");
  abort.abort(new Error("cancel only A"));
  await rejected;
  result.resolve(8);
  await sibling;
  expect(read).toHaveBeenCalledOnce();
});

it("checks ownership even for cached positions and does not cache failed reads", async () => {
  const read = vi.fn().mockRejectedValueOnce(new Error("PG unavailable")).mockResolvedValueOnce(10);
  const assertCurrent = vi.fn(async () => {});
  const progress = new NativeProjectionProgress({ initialThrough: 4, read, assertCurrent });
  const signal = new AbortController().signal;
  await expect(progress.wait(10, signal)).rejects.toThrow("PG unavailable");
  await progress.wait(10, signal);
  expect(read).toHaveBeenCalledTimes(2);
  assertCurrent.mockRejectedValueOnce(new Error("owner retired"));
  await expect(progress.wait(4, signal)).rejects.toThrow("owner retired");
  expect(read).toHaveBeenCalledTimes(2);
});

it("rejects a regressed primary position and ignores telemetry failure", async () => {
  const read = vi.fn().mockResolvedValueOnce(3).mockResolvedValueOnce(6);
  const progress = new NativeProjectionProgress({
    initialThrough: 4,
    read,
    assertCurrent: async () => {},
    observe: () => {
      throw new Error("observer failed");
    },
  });
  const signal = new AbortController().signal;
  await expect(progress.wait(6, signal)).rejects.toThrow("regressed");
  await progress.wait(6, signal);
});

it("does not issue another query after every waiter cancels during backoff", async () => {
  vi.useFakeTimers();
  try {
    const read = vi.fn(async () => 0);
    const progress = new NativeProjectionProgress({
      initialThrough: 0,
      read,
      assertCurrent: async () => {},
    });
    const abort = new AbortController();
    const wait = progress.wait(1, abort.signal);
    const rejected = expect(wait).rejects.toThrow("cancelled");
    await vi.advanceTimersByTimeAsync(0);
    expect(read).toHaveBeenCalledOnce();
    abort.abort(new Error("cancelled"));
    await rejected;
    await vi.advanceTimersByTimeAsync(100);
    expect(read).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
