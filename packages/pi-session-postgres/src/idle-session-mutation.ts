import type { Database } from "@pi-cloud/database";
import { NativeSessionError } from "./native-session-error.ts";
import { type Transaction } from "kysely";

/** Cold administrative writes share Run claim's physical Session lock. They
 * must never allocate native sequence beside an active acknowledged writer. */
export async function assertIdleNativeSession(
  tx: Transaction<Database>,
  tenantId: string,
  sessionId: string,
) {
  const session = await tx
    .selectFrom("pi_sessions")
    .select(["id", "unsealed_runs"])
    .where("tenant_id", "=", tenantId)
    .where("id", "=", sessionId)
    .forUpdate()
    .executeTakeFirst();
  if (!session) throw new NativeSessionError("not_found", "Pi Session was not found");
  if (session.unsealed_runs !== "0")
    throw new NativeSessionError(
      "storage",
      "Native Session must settle before administrative changes",
    );
}
