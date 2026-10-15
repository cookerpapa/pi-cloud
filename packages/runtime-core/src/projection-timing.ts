import { operationalLog, safeErrorCode, type PiCloudMetrics } from "@pi-cloud/observability";
import type { KafkaAcceptedFactRecord } from "./kafka-accepted-fact-consumer.ts";

type Stage =
  "publication" | "projection" | "boundary" | "dispatch_commit" | "tool_route" | "view_notify";

/** Low-cardinality metrics; slow/failed record logs contain routing identity,
 * never the Fact body, SQL text or an exception message. */
export class ProjectionTiming {
  readonly #started = performance.now();
  readonly #stages: Partial<Record<Stage, number>> = {};
  #failed: Stage | undefined;
  constructor(readonly metrics?: PiCloudMetrics) {}

  async measure<T>(stage: Stage, work: () => Promise<T>): Promise<T> {
    const started = performance.now();
    let outcome = "ok";
    try {
      return await work();
    } catch (error) {
      this.#failed = stage;
      outcome = "error";
      throw error;
    } finally {
      const elapsed = performance.now() - started;
      this.#stages[stage] = elapsed;
      this.#observe(stage, outcome, elapsed);
    }
  }

  finish(record: KafkaAcceptedFactRecord, error?: unknown) {
    const durationMs = performance.now() - this.#started;
    const failed = this.#failed ?? (error === undefined ? undefined : "record");
    this.#observe("record", failed ? "error" : "ok", durationMs);
    if (!failed && durationMs < 1_000) return;
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      /^[0-9A-Z]{5}$/.test(error.code)
        ? error.code
        : safeErrorCode(error);
    try {
      operationalLog({
        service: "pi-cloud-projector",
        level: "warn",
        event: "session.projection.slow_or_failed",
        attributes: {
          topic: record.topic,
          partition: record.partition,
          offset: record.offset.toString(),
          kind: record.fact.kind,
          runId: record.fact.scope.runId,
          piSessionId: record.fact.scope.piSessionId,
          durationMs,
          stages: this.#stages,
          ...(failed ? { failedStage: failed, errorCode: code } : {}),
        },
      });
    } catch {
      /* Observation cannot prevent dispatch or turn success into replay. */
    }
  }

  #observe(stage: Stage | "record", outcome: string, durationMs: number) {
    try {
      this.metrics?.sessionProjectionDuration.observe({ stage, outcome }, durationMs / 1000);
    } catch {
      /* See finish(). */
    }
  }
}
