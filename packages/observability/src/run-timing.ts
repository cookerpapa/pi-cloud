import type { PiCloudMetrics } from "./metrics.ts";
import { operationalLog } from "./logger.ts";
import { AsyncLocalStorage } from "node:async_hooks";

export type PreparationOutcome = "completed" | "failed" | "cancelled";
export type PreparationDetails = {
  conversationId?: number;
  taskId?: number;
  nativePhase?: "prepare" | "request" | "select" | "summarize";
  purpose?: "agent" | "context_maintenance";
  samplingAttempt?: number;
  messageCount?: number;
  uploadCount?: number;
  reused?: boolean;
  reachedModel?: boolean;
};
export type PreparationOptions = { signal?: AbortSignal; details?: PreparationDetails };
export type PreparationWorkSample = {
  durationMs: number;
  outcome: PreparationOutcome;
  byteLength?: number;
};
type Work = "storage_read" | "image_read";
const active = new AsyncLocalStorage<RunPreparationTiming>();

/** Capture the current stage, rather than looking up a different Lane when an
 * asynchronous read finishes. No per-read log, payload walk, or retained body. */
export function capturePreparationWork(
  kind: Work,
): ((sample: PreparationWorkSample) => void) | undefined {
  const timing = active.getStore();
  return timing?.recording ? (sample) => timing.record(kind, sample) : undefined;
}

export class RunPreparationTiming {
  readonly startedAtMs = Date.now();
  readonly started = performance.now();
  #closed = false;
  readonly #work = new Map<
    Work,
    { count: number; durationMs: number; bytes: number; incomplete: number }
  >();
  constructor(
    readonly runId: string,
    readonly stage: string,
    readonly metrics?: PiCloudMetrics,
    readonly options: PreparationOptions = {},
  ) {}
  get recording() {
    return !this.#closed;
  }
  record(kind: Work, sample: PreparationWorkSample): void {
    if (this.#closed || !Number.isFinite(sample.durationMs) || sample.durationMs < 0) return;
    const value = this.#work.get(kind) ?? { count: 0, durationMs: 0, bytes: 0, incomplete: 0 };
    value.count++;
    value.durationMs += sample.durationMs;
    if (Number.isSafeInteger(sample.byteLength) && sample.byteLength! >= 0)
      value.bytes += sample.byteLength!;
    if (sample.outcome !== "completed") value.incomplete++;
    this.#work.set(kind, value);
  }
  finish(outcome: PreparationOutcome): void {
    if (this.#closed) return;
    this.#closed = true;
    const durationMs = performance.now() - this.started;
    try {
      this.metrics?.runPreparationDuration.observe(
        { stage: this.stage, outcome },
        durationMs / 1000,
      );
      const details: Record<string, unknown> = {};
      // Explicit keys keep accidentally supplied arguments/results out of logs.
      const source = this.options.details;
      for (const key of [
        "conversationId",
        "taskId",
        "nativePhase",
        "purpose",
        "samplingAttempt",
        "messageCount",
        "uploadCount",
        "reused",
        "reachedModel",
      ] as const)
        if (source?.[key] !== undefined) details[key] = source[key];
      for (const [kind, work] of this.#work) {
        details[`${kind}Count`] = work.count;
        details[`${kind}Ms`] = work.durationMs;
        details[`${kind}Incomplete`] = work.incomplete;
        if (kind === "image_read") details.imageBytes = work.bytes;
      }
      operationalLog({
        service: "pi-cloud-worker",
        level: "info",
        event: "run.preparation.timing",
        attributes: {
          runId: this.runId,
          stage: this.stage,
          outcome,
          startedAtMs: this.startedAtMs,
          startedMonotonicMs: this.started,
          processStartedAtMs: performance.timeOrigin,
          durationMs,
          ...details,
        },
      });
    } catch {
      // Diagnostics cannot change a result, an acknowledged write or its error.
    }
  }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    return active.run(this, async () => {
      try {
        const value = await operation();
        this.finish("completed");
        return value;
      } catch (error) {
        this.finish(this.options.signal?.aborted ? "cancelled" : "failed");
        throw error;
      }
    });
  }
}

export function startRunPreparation(
  runId: string,
  stage: string,
  metrics?: PiCloudMetrics,
  options?: PreparationOptions,
): RunPreparationTiming {
  return new RunPreparationTiming(runId, stage, metrics, options);
}

/** The same bounded stages as the histograms, correlated in logs rather than
 * high-cardinality metric labels. Never capture operation inputs or results. */
export async function measureRunPreparation<T>(
  runId: string,
  stage: string,
  metrics: PiCloudMetrics | undefined,
  operation: () => Promise<T>,
  options?: PreparationOptions,
): Promise<T> {
  return startRunPreparation(runId, stage, metrics, options).run(operation);
}
