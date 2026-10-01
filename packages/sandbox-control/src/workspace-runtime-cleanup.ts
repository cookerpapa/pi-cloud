import type { PostgresQueueWake } from "@pi-cloud/database";

export type WorkspaceCleanupWake = Pick<PostgresQueueWake, "generation" | "wait"> & {
  refresh?(): void;
};

/** One cleanup owner; notifications accelerate the same authoritative PG scan. */
export async function runWorkspaceRuntimeCleanup(
  wake: WorkspaceCleanupWake,
  signal: AbortSignal,
  sweep: () => Promise<void>,
  onError: (error: unknown) => void,
): Promise<void> {
  let observed = wake.generation;
  while (!signal.aborted) {
    wake.refresh?.();
    await wake.wait(observed, 30_000, signal);
    if (signal.aborted) break;
    // Capture before the scan: a hint arriving during it requests another pass.
    observed = wake.generation;
    try {
      await sweep();
    } catch (error) {
      onError(error);
    }
  }
}
