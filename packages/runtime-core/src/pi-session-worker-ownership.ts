import type { Database } from "@pi-cloud/database";
import { sql, type RawBuilder, type Transaction } from "kysely";

export class PiSessionWorkerOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiSessionWorkerOwnershipError";
  }
}

/** Ready Lane work still needs a current physical owner or a fully closed family. */
export function piSessionWorkerAvailable(
  tenantId: RawBuilder<unknown>,
  piSessionId: RawBuilder<unknown>,
  expectedWorkerId: string,
): RawBuilder<boolean> {
  return sql<boolean>`exists(
    select 1 from pi_sessions p
    left join session_leases l on l.tenant_id=p.tenant_id and l.pi_session_id=p.id
    left join run_attempts w on w.id=l.writer_id
    where p.tenant_id=${tenantId} and p.id=${piSessionId}
      and ((l.lease_id is null and p.unsealed_runs=0)
        or (l.valid_until>clock_timestamp() and w.claim_owner_id=${expectedWorkerId}
          and w.native_writer_failed_at is null and w.native_writer_sealed_at is null))
  )`;
}

export type LockedPiSessionOwnership = { leaseEpoch: string; unsealedRuns: string };

export async function lockPiSessionWorkerOwnership(
  tx: Transaction<Database>,
  tenantId: string,
  piSessionId: string,
): Promise<LockedPiSessionOwnership> {
  const row = await tx
    .selectFrom("pi_sessions")
    .select(["lease_epoch", "unsealed_runs"])
    .where("tenant_id", "=", tenantId)
    .where("id", "=", piSessionId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw new PiSessionWorkerOwnershipError("Physical Pi Session was not found");
  return { leaseEpoch: row.lease_epoch, unsealedRuns: row.unsealed_runs };
}

export async function selectNativeSessionWriter(
  tx: Transaction<Database>,
  input: {
    tenantId: string;
    piSessionId: string;
    workerId: string;
    attemptId: string;
    unsealedRuns: string;
  },
): Promise<string | undefined> {
  const lease = await tx
    .selectFrom("session_leases as l")
    .innerJoin("run_attempts as w", "w.id", "l.writer_id")
    .select([
      "l.writer_id",
      "w.claim_owner_id",
      "w.native_writer_failed_at",
      "w.native_writer_sealed_at",
    ])
    .select(sql<boolean>`l.valid_until <= clock_timestamp()`.as("expired"))
    .where("l.tenant_id", "=", input.tenantId)
    .where("l.pi_session_id", "=", input.piSessionId)
    .executeTakeFirst();
  if (lease) {
    if (
      lease.claim_owner_id !== input.workerId ||
      lease.expired ||
      lease.native_writer_failed_at ||
      lease.native_writer_sealed_at
    )
      return undefined;
    return lease.writer_id;
  }
  return input.unsealedRuns === "0" ? input.attemptId : undefined;
}
