import { afterEach, expect, it, vi } from "vitest";
import { WorkerMemoryMonitor } from "../src/worker-memory-monitor.ts";
const state = vi.hoisted(() => ({
  workers: [] as Array<
    import("node:events").EventEmitter & { terminate: ReturnType<typeof vi.fn> }
  >,
  heap: { used_heap_size: 100, heap_size_limit: 1_000 },
}));
vi.mock("node:v8", () => ({ getHeapStatistics: () => state.heap }));
vi.mock("node:worker_threads", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    Worker: class extends EventEmitter {
      terminate = vi.fn(async () => {
        this.emit("exit", 1);
        return 1;
      });
      constructor(code: string, options: unknown) {
        super();
        expect(code).toContain("process.constrainedMemory()");
        expect(options).toEqual({ eval: true, execArgv: [] });
        state.workers.push(this);
      }
    },
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  state.workers.length = 0;
  state.heap.used_heap_size = 100;
});

it("uses current heap/RSS with a fresh off-thread limit and rejects stale samples", async () => {
  let now = 1_000;
  vi.spyOn(process.hrtime, "bigint").mockImplementation(() => BigInt(now) * 1_000_000n);
  const rss = vi.spyOn(process.memoryUsage, "rss").mockReturnValue(100);
  const mainProbe = vi.spyOn(process, "constrainedMemory").mockImplementation(() => {
    throw new Error("synchronous main-thread probe");
  });
  const failure = vi.fn(),
    monitor = new WorkerMemoryMonitor(failure);
  expect(monitor.hasHeadroom()).toBe(false);
  const starting = monitor.start(),
    worker = state.workers[0]!;
  worker.emit("message", { limit: 1_000, startedAt: now });
  await starting;
  try {
    expect(monitor.hasHeadroom()).toBe(true);
    rss.mockReturnValue(850);
    expect(monitor.hasHeadroom()).toBe(false);
    rss.mockReturnValue(100);
    state.heap.used_heap_size = 850;
    expect(monitor.hasHeadroom()).toBe(false);
    state.heap.used_heap_size = 100;
    now += 2_501;
    expect(monitor.hasHeadroom()).toBe(false);
    worker.emit("message", { limit: 100, startedAt: now });
    expect(monitor.hasHeadroom()).toBe(false);
    worker.emit("message", { limit: 0, startedAt: now });
    expect(monitor.hasHeadroom()).toBe(true);
    expect(mainProbe).not.toHaveBeenCalled();
    worker.emit("error", new Error("probe failed"));
    expect(monitor.hasHeadroom()).toBe(false);
    worker.emit("message", { limit: 1_000, startedAt: now });
    expect(monitor.hasHeadroom()).toBe(false);
    worker.emit("exit", 1);
    expect(failure).toHaveBeenCalledTimes(1);
  } finally {
    await monitor.close();
    await monitor.close();
  }
  expect(worker.terminate).toHaveBeenCalledTimes(1);
});

it("joins its sampling thread when stopped during startup", async () => {
  const monitor = new WorkerMemoryMonitor(vi.fn());
  const started = expect(monitor.start()).rejects.toThrow("before its first sample");
  await monitor.close();
  await started;
  expect(monitor.hasHeadroom()).toBe(false);
  expect(state.workers[0]!.terminate).toHaveBeenCalledTimes(1);
});
