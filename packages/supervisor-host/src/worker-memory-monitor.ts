import { Worker } from "node:worker_threads";
import { getHeapStatistics } from "node:v8";

const monotonicMs = () => Number(process.hrtime.bigint() / 1_000_000n);
const MAX_SAMPLE_AGE_MS = 2_500;
type LimitSample = { limit: number; startedAt: number };

// libuv's cgroup discovery is synchronous and can stall for tens of milliseconds.
// Keep it off the Agent/PG callback thread; only the limit is sampled, not usage.
const probe = `
  const { parentPort } = require('node:worker_threads');
  const sample = () => {
    const startedAt = Number(process.hrtime.bigint() / 1_000_000n);
    parentPort.postMessage({ limit: process.constrainedMemory(), startedAt });
  };
  sample();
  setInterval(sample, 1000);
`;

/** A soft admission hint; the OS still enforces the actual memory limit. */
export class WorkerMemoryMonitor {
  #worker: Worker | undefined;
  #sample: LimitSample | undefined;
  #closed = false;
  #failed = false;

  constructor(readonly onFailure: (error: Error) => void) {}

  async start(): Promise<void> {
    if (this.#worker || this.#closed) throw new Error("Memory monitor can only start once");
    const worker = new Worker(probe, { eval: true, execArgv: [] });
    this.#worker = worker;
    const fail = (error: Error) => {
      if (this.#closed || this.#failed) return;
      this.#failed = true;
      this.#sample = undefined;
      this.onFailure(error);
    };
    worker.on("message", (sample: LimitSample) => {
      if (!this.#closed && !this.#failed) this.#sample = sample;
    });
    worker.on("error", fail);
    worker.on("exit", (code) => fail(new Error(`Memory monitor exited (${code})`)));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Memory monitor startup timed out")),
          5_000,
        );
        const done = (error?: Error) => {
          clearTimeout(timer);
          worker.off("message", ready);
          worker.off("error", rejected);
          worker.off("exit", exited);
          if (error) reject(error);
          else resolve();
        };
        const ready = () => done();
        const rejected = (error: Error) => done(error);
        const exited = () => done(new Error("Memory monitor stopped before its first sample"));
        worker.once("message", ready);
        worker.once("error", rejected);
        worker.once("exit", exited);
      });
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  hasHeadroom(): boolean {
    const sample = this.#sample;
    if (
      !sample ||
      this.#closed ||
      this.#failed ||
      monotonicMs() - sample.startedAt > MAX_SAMPLE_AGE_MS
    )
      return false;
    const heap = getHeapStatistics();
    return (
      heap.used_heap_size < heap.heap_size_limit * 0.85 &&
      (sample.limit === 0 || process.memoryUsage.rss() < sample.limit * 0.85)
    );
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#sample = undefined;
    const worker = this.#worker;
    this.#worker = undefined;
    await worker?.terminate();
  }
}
