import { sql, type Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import { parseExecutionTargetGrants, type ExecutionTargetGrant } from "@pi-cloud/protocol";

/** Admission snapshot only. Hot Tool routing uses the ordered binding view. */
export async function readExecutionTargetGrants(
  db: Kysely<Database>,
  tenantId: string,
  sessionId: string,
): Promise<ExecutionTargetGrant[]> {
  const { rows } = await sql<{
    id: string;
    revision: string;
    kind: string;
    name: string;
    capabilities: unknown;
  }>`
    select id,revision::text,kind,name,capabilities from execution_targets
    where tenant_id=${tenantId}::uuid and bound_session_id=${sessionId}::uuid and enabled
    order by id for share`.execute(db);
  return parseExecutionTargetGrants(
    rows.map((row) => ({
      targetId: row.id,
      revision: row.revision,
      kind: row.kind,
      name: row.name,
      capabilities: row.capabilities,
    })),
  );
}
