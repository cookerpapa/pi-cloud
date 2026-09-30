import { PostgresQueueWake } from "@pi-cloud/database";
import { afterEach, expect, it, vi } from "vitest";
import { runWorkspaceRuntimeCleanup } from "../src/workspace-runtime-cleanup.ts";

afterEach(() => vi.useRealTimers());

it("remembers hints during cleanup, never overlaps, and joins an active pass on shutdown", async () => {
  const wake = new PostgresQueueWake(),
    controller = new AbortController();
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sweep = vi.fn(async () => {
    await pending;
  });
  const loop = runWorkspaceRuntimeCleanup(wake, controller.signal, sweep, vi.fn());
  wake.notify();
  await vi.waitFor(() => expect(sweep).toHaveBeenCalledOnce());
  wake.notify();
  wake.notify();
  expect(sweep).toHaveBeenCalledOnce();
  release();
  await vi.waitFor(() => expect(sweep).toHaveBeenCalledTimes(2));
  controller.abort();
  await loop;
  wake.notify();
  expect(sweep).toHaveBeenCalledTimes(2);
});

it("polls after missing hints and retries a failed pass without a hot loop", async () => {
  vi.useFakeTimers();
  const wake = new PostgresQueueWake(),
    controller = new AbortController();
  const failure = new Error("cleanup unavailable");
  const sweep = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
  const onError = vi.fn();
  const loop = runWorkspaceRuntimeCleanup(wake, controller.signal, sweep, onError);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(sweep).toHaveBeenCalledOnce();
  expect(onError).toHaveBeenCalledWith(failure);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(sweep).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(sweep).toHaveBeenCalledTimes(2);
  controller.abort();
  await loop;
});

it("waits for an already running cleanup before shutdown finishes", async () => {
  const wake = new PostgresQueueWake(),
    controller = new AbortController();
  let release!: () => void;
  const sweep = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  let done = false;
  const loop = runWorkspaceRuntimeCleanup(wake, controller.signal, sweep, vi.fn()).then(() => {
    done = true;
  });
  wake.notify();
  await vi.waitFor(() => expect(sweep).toHaveBeenCalledOnce());
  controller.abort();
  await Promise.resolve();
  expect(done).toBe(false);
  release();
  await loop;
  expect(done).toBe(true);
});
