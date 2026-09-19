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
    left join session_leases l on l.tenant_id=p.tenant_id and l.pi_session_id=p.id and l.released_at is null
    where p.tenant_id=${tenantId} and p.id=${piSessionId}
      and ((l.lease_id is null and p.unsealed_runs=0)
        or (l.valid_until>clock_timestamp() and l.sandbox_id=${expectedWorkerId}::uuid
          and l.writer_failed_at is null and l.writer_sealed_at is null))
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
