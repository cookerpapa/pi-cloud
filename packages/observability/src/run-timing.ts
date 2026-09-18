import type { PiCloudMetrics } from "./metrics.ts";
import { operationalLog } from "./logger.ts";

/** The same bounded stages as the histograms, correlated in logs rather than
 * high-cardinality metric labels. Never capture operation inputs or results. */
export async function measureRunPreparation<T>(
  runId: string,
  stage: string,
  metrics: PiCloudMetrics | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAtMs = Date.now();
  const started = performance.now();
  let outcome = "failed";
  try {
    const result = await operation();
    outcome = "completed";
    return result;
  } finally {
    const durationMs = performance.now() - started;
    try {
      metrics?.runPreparationDuration.observe({ stage, outcome }, durationMs / 1_000);
      operationalLog({
        service: "pi-cloud-worker",
        level: "info",
        event: "run.preparation.timing",
        attributes: { runId, stage, outcome, startedAtMs, durationMs },
      });
    } catch {
      // A failed diagnostic sink cannot change a completed operation or replace
      // the original failure, especially after an acknowledged durable write.
    }
  }
}
