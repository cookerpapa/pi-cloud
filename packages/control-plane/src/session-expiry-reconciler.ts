import type { Database } from "@pi-cloud/database";
import { createExecutionReference } from "@pi-cloud/protocol";
import { sql, type Kysely } from "kysely";
import { reconcileExecutionScope } from "./assignment-reconciler.ts";

export function maintenanceLockBusy(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "55P03";
}

/** A rotating scan, not another scheduler or ownership receipt. Restart may reset the cursor. */
export class SessionExpiryReconciler {
  #cursor: string | undefined;
  constructor(private readonly database: Kysely<Database>) {}

  async sweep(limit = 100): Promise<{ expiredAssignments: number; scannedSessions: number }> {
    if (!Number.isSafeInteger(limit) || limit < 1)
      throw new TypeError("Invalid Session expiry limit");
    const candidates = await this.database
      .selectFrom("active_execution_scopes as scope")
      .innerJoin("workers as worker", "worker.id", "scope.worker_id")
      .innerJoin("runs as run", "run.id", "scope.run_id")
      .select([
        "scope.session_id",
        "scope.lease_id",
        "scope.worker_id",
        "scope.run_id",
        "scope.turn_id",
        "scope.fencing_token",
      ])
      .where("worker.state", "=", "ready")
      .where("run.output_seal_id", "is", null)
      .where("scope.valid_until", "<=", sql<Date>`(select clock_timestamp())`)
      .$if(this.#cursor !== undefined, (q) => q.where("scope.lease_id", ">", this.#cursor!))
      .orderBy("scope.lease_id")
      .limit(limit)
      .execute();
    let expiredAssignments = 0;
    for (const candidate of candidates) {
      // Move past a busy or failed candidate; revisit it after wrapping.
      this.#cursor = candidate.lease_id;
      try {
        const result = await this.database.transaction().execute((tx) =>
          reconcileExecutionScope(
            tx,
            {
              sessionId: candidate.session_id,
              runId: candidate.run_id,
              turnId: candidate.turn_id,
              executionReference: createExecutionReference(
                candidate.lease_id,
                candidate.run_id,
                Number(candidate.fencing_token),
              ),
            },
            candidate.worker_id,
            true,
          ),
        );
        if (result !== "skipped") expiredAssignments++;
      } catch (error) {
        // NOWAIT aborts and rolls back the whole transaction, including earlier locks.
        if (!maintenanceLockBusy(error)) throw error;
      }
    }
    if (candidates.length < limit) this.#cursor = undefined;
    return { expiredAssignments, scannedSessions: candidates.length };
  }
}
