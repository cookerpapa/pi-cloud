import type { Database } from "@pi-cloud/database";
import { SessionError } from "@earendil-works/pi-agent-core";
import { sql, type Transaction } from "kysely";

/** Cold administrative writes share Run claim's physical Session lock. They
 * must never allocate native sequence beside an active acknowledged writer. */
export async function assertIdleNativeSession(
  tx: Transaction<Database>,
  tenantId: string,
  sessionId: string,
) {
  const session = await tx
    .selectFrom("pi_sessions")
    .select("id")
    .where("tenant_id", "=", tenantId)
    .where("id", "=", sessionId)
    .forUpdate()
    .executeTakeFirst();
  if (!session) throw new SessionError("not_found", "Pi Session was not found");
  const busy = await sql<{ busy: boolean }>`select exists(
    select 1 from sessions s join runs r on r.session_id=s.id
    left join run_attempts a on a.run_id=r.id
    where s.tenant_id=${tenantId}::uuid and s.pi_session_id=${sessionId}
      and (r.state in ('claimed','provisioning','restoring','running','settling','cancel_requested')
        or (a.output_seal_id is not null and a.output_sealed_at is null))
  ) as busy`.execute(tx);
  if (busy.rows[0]?.busy)
    throw new SessionError("storage", "Native Session must settle before administrative changes");
}
