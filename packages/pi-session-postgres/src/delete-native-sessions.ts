import { SessionError } from "@earendil-works/pi-agent-core";
import type { Database } from "@pi-cloud/database";
import { sql, type Transaction } from "kysely";

/** Cold administrative deletion; the caller co-commits its product mutation. */
export async function deletePostgresPiSessionsInTransaction(
  transaction: Transaction<Database>,
  tenantId: string,
  ids: readonly string[],
): Promise<void> {
  if (ids.length === 0) return;
  const sessions = await transaction
    .selectFrom("pi_sessions")
    .select(["id", "unsealed_runs"])
    .where("tenant_id", "=", tenantId)
    .where(sql<boolean>`id=any(${[...ids]}::text[])`)
    .orderBy("id")
    .forUpdate()
    .noWait()
    .execute();
  if (sessions.some((row) => row.unsealed_runs !== "0"))
    throw new SessionError("storage", "Native Session must settle before deletion");
  const referenced = await transaction
    .selectFrom("sessions")
    .select("id")
    .where("tenant_id", "=", tenantId)
    .where(sql<boolean>`pi_session_id=any(${[...ids]}::text[])`)
    .limit(1)
    .executeTakeFirst();
  if (referenced) throw new SessionError("storage", "Native Session still has a product reference");
  const current = await transaction
    .selectFrom("session_leases")
    .select("lease_id")
    .where("tenant_id", "=", tenantId)
    .where(sql<boolean>`pi_session_id=any(${[...ids]}::text[])`)
    .where("released_at", "is", null)
    .limit(1)
    .executeTakeFirst();
  if (current) throw new SessionError("storage", "Native Session still has a current writer");
  await transaction
    .deleteFrom("session_leases")
    .where("tenant_id", "=", tenantId)
    .where(sql<boolean>`pi_session_id=any(${[...ids]}::text[])`)
    .where("released_at", "is not", null)
    .execute();
  await transaction
    .deleteFrom("pi_sessions")
    .where("tenant_id", "=", tenantId)
    .where(sql<boolean>`id=any(${[...ids]}::text[])`)
    .execute();
}
