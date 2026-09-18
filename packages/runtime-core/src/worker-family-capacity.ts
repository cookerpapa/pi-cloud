import type { Database } from "@pi-cloud/database";
import { sql, type Kysely, type Transaction } from "kysely";

/** One row is one physically owned Session, regardless of its number of Lanes. */
export async function countWorkerLeaseFamilies(
  db: Kysely<Database>,
  sandboxId: string,
): Promise<number> {
  const row = await db
    .selectFrom("session_leases")
    .select(sql<string>`count(*)`.as("count"))
    .where("sandbox_id", "=", sandboxId)
    .executeTakeFirstOrThrow();
  return Number(row.count);
}

/** A task release does not release the shared lease while another Lane uses it. */
export async function releaseExecutionScope(
  tx: Transaction<Database>,
  input: {
    tenantId: string;
    attemptId: string;
    leaseId: string;
    fencingToken: number;
    now: Date;
  },
): Promise<void> {
  const lease = await tx
    .selectFrom("session_leases")
    .selectAll()
    .where("tenant_id", "=", input.tenantId)
    .where("lease_id", "=", input.leaseId)
    .where("fencing_token", "=", String(input.fencingToken))
    .forKeyShare()
    .executeTakeFirst();
  if (!lease) throw new Error("Task release lost its Session lease");
  await tx
    .selectFrom("pi_sessions")
    .select("id")
    .where("tenant_id", "=", lease.tenant_id)
    .where("id", "=", lease.pi_session_id)
    .forUpdate()
    .executeTakeFirstOrThrow();
  const released = await tx
    .updateTable("run_attempts")
    .set({ execution_released_at: input.now })
    .where("id", "=", input.attemptId)
    .where("lease_id", "=", lease.lease_id)
    .where("fencing_token", "=", String(input.fencingToken))
    .where("execution_released_at", "is", null)
    .executeTakeFirst();
  if (released.numUpdatedRows !== 1n) throw new Error("Task execution scope was already released");
  // The lease identity cannot be deleted/replaced under KEY SHARE. The physical
  // Session lock above protects peer admission; reuse this identity, not expiry.
  await releaseLockedIdleSessionLease(tx, lease, input.now);
}

/** Caller holds the physical Session lock; no distributed work is queued here. */
export async function releaseIdleSessionLease(
  tx: Transaction<Database>,
  leaseId: string,
  now: Date,
): Promise<boolean> {
  const lease = await tx
    .selectFrom("session_leases")
    .selectAll()
    .where("lease_id", "=", leaseId)
    .executeTakeFirst();
  if (!lease) return false;
  return releaseLockedIdleSessionLease(tx, lease, now);
}

async function releaseLockedIdleSessionLease(
  tx: Transaction<Database>,
  lease: {
    lease_id: string;
    tenant_id: string;
    pi_session_id: string;
    writer_id: string;
    sandbox_id: string;
  },
  now: Date,
): Promise<boolean> {
  const peer = await tx
    .selectFrom("run_attempts as a")
    .innerJoin("runs as r", "r.current_attempt_id", "a.id")
    .innerJoin("sessions as s", "s.id", "r.session_id")
    .select("a.id")
    .where("s.tenant_id", "=", lease.tenant_id)
    .where("s.pi_session_id", "=", lease.pi_session_id)
    .where("a.native_writer_id", "=", lease.writer_id)
    .where((eb) =>
      eb.or([
        eb.and([eb("a.lease_id", "=", lease.lease_id), eb("a.execution_released_at", "is", null)]),
        eb.and([
          eb("a.lease_id", "is", null),
          eb("a.state", "in", [
            "claimed",
            "provisioning",
            "restoring",
            "running",
            "settling",
            "cancel_requested",
          ]),
        ]),
      ]),
    )
    .limit(1)
    .executeTakeFirst();
  if (peer) return false;
  const worker = await tx
    .selectFrom("sandboxes")
    .select(["state"])
    .where("id", "=", lease.sandbox_id)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
  await tx.deleteFrom("session_leases").where("lease_id", "=", lease.lease_id).execute();
  const remaining = await countWorkerLeaseFamilies(tx, lease.sandbox_id);
  await tx
    .updateTable("sandboxes")
    .set({
      active_sessions: remaining,
      state: remaining === 0 && worker.state === "leased" ? "ready" : worker.state,
      updated_at: now,
    })
    .where("id", "=", lease.sandbox_id)
    .execute();
  return true;
}
