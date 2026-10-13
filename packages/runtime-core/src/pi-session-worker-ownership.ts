import type { Database } from "@pi-cloud/database";
import { sql, type RawBuilder, type Transaction } from "kysely";

export class PiSessionWorkerOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiSessionWorkerOwnershipError";
  }
}

/** A root work item needs an idle physical Session and current or closed ownership. */
export function piSessionWorkerAvailable(
  tenantId: RawBuilder<unknown>,
  piSessionId: RawBuilder<unknown>,
): RawBuilder<boolean> {
  return sql<boolean>`exists(
    select 1 from pi_sessions p
    where p.tenant_id=${tenantId} and p.id=${piSessionId}
      and not exists(select 1 from session_leases l where l.tenant_id=p.tenant_id and l.pi_session_id=p.id and l.released_at is null)
  )`;
}

export type LockedPiSessionOwnership = { leaseEpoch: string };

export async function lockPiSessionWorkerOwnership(
  tx: Transaction<Database>,
  tenantId: string,
  piSessionId: string,
): Promise<LockedPiSessionOwnership> {
  const row = await tx
    .selectFrom("pi_sessions")
    .select("lease_epoch")
    .where("tenant_id", "=", tenantId)
    .where("id", "=", piSessionId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw new PiSessionWorkerOwnershipError("Physical Pi Session was not found");
  return { leaseEpoch: row.lease_epoch };
}
