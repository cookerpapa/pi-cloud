import { sql, type Transaction } from "kysely";
import type { Database } from "@pi-cloud/database";
import { ControlPlaneStoreError } from "./control-plane-store-error.ts";

/** Called under the existing Session quiescence/row locks. Keep a destination
 * cleanup address until its admission has actually been revoked. */
export async function unbindSessionTargets(
  tx: Transaction<Database>,
  tenantId: string,
  ids: readonly string[],
): Promise<void> {
  if (!ids.length) return;
  const pending =
    await sql`select 1 from execution_target_bindings where tenant_id=${tenantId}::uuid and session_id=any(${ids}::uuid[]) limit 1`.execute(
      tx,
    );
  if (pending.rows.length)
    throw new ControlPlaneStoreError(
      "conflict",
      "Device admission is still closing; retry after cleanup completes",
    );
  await sql`update execution_targets set bound_session_id=null,revision=revision+1,updated_at=clock_timestamp() where tenant_id=${tenantId}::uuid and bound_session_id=any(${ids}::uuid[])`.execute(
    tx,
  );
}
