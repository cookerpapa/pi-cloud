import type { Database } from "@pi-cloud/database";
import type { Transaction } from "kysely";

/** Closing a task does not release a sibling Lane's shared Session owner. */
export async function releaseExecutionScope(
  tx: Transaction<Database>,
  input: { tenantId: string; runId: string; leaseId: string; fencingToken: number; now: Date },
): Promise<void> {
  const lease = await tx
    .selectFrom("session_leases")
    .select(["tenant_id", "pi_session_id"])
    .where("tenant_id", "=", input.tenantId)
    .where("lease_id", "=", input.leaseId)
    .where("fencing_token", "=", String(input.fencingToken))
    .where("released_at", "is", null)
    .forKeyShare()
    .executeTakeFirstOrThrow();
  await tx
    .selectFrom("pi_sessions")
    .select("id")
    .where("tenant_id", "=", lease.tenant_id)
    .where("id", "=", lease.pi_session_id)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const released = await tx
    .updateTable("runs")
    .set({ execution_released_at: input.now })
    .where("tenant_id", "=", input.tenantId)
    .where("id", "=", input.runId)
    .where("lease_id", "=", input.leaseId)
    .where("fencing_token", "=", String(input.fencingToken))
    .where("execution_released_at", "is", null)
    .executeTakeFirst();
  if (released.numUpdatedRows !== 1n) throw new Error("Run execution scope was already released");
  await releaseIdleSessionLease(tx, input.leaseId, input.now);
}

/** Caller holds the physical Session lock. Retained rows are closure evidence,
 * not capacity reservations and cannot be renewed after release. */
export async function releaseIdleSessionLease(
  tx: Transaction<Database>,
  leaseId: string,
  now: Date,
): Promise<boolean> {
  const peer = await tx
    .selectFrom("runs")
    .select("id")
    .where("lease_id", "=", leaseId)
    .where("execution_released_at", "is", null)
    .limit(1)
    .executeTakeFirst();
  if (peer) return false;
  const result = await tx
    .updateTable("session_leases")
    .set({ released_at: now })
    .where("lease_id", "=", leaseId)
    .where("released_at", "is", null)
    .executeTakeFirst();
  return result.numUpdatedRows === 1n;
}
