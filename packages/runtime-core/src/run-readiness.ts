import type { Database } from "@pi-cloud/database";
import { sql, type RawBuilder, type Transaction } from "kysely";

/** Evaluated by input acceptance or seal projection under the Lane row lock. */
export function laneDependenciesReady(
  tenantId: string,
  sessionId: string,
  mailbox: RawBuilder<unknown>,
): RawBuilder<boolean> {
  return sql<boolean>`exists(select 1 from sessions s where s.tenant_id=${tenantId}::uuid
      and s.id=${sessionId}::uuid and s.state in ('cold','idle') and s.archived_at is null)
    and not exists(select 1 from runs prior where prior.tenant_id=${tenantId}::uuid
      and prior.session_id=${sessionId}::uuid and prior.mailbox_position<${mailbox}
      and prior.state not in ('completed','failed','cancelled','timed_out'))
    and not exists(select 1 from runs prior
      where prior.tenant_id=${tenantId}::uuid and prior.session_id=${sessionId}::uuid
        and prior.output_seal_id is not null and prior.output_sealed_at is null)`;
}

/** Caller holds the product Session row lock. Acceptance and closure therefore
 * cannot miss each other's commits; NOTIFY is only a wake-up, never readiness.
 * Physical owner placement remains a separate atomic admission decision. */
export async function advanceLaneReadiness(
  tx: Transaction<Database>,
  tenantId: string,
  sessionId: string,
): Promise<void> {
  await sql`update runs candidate set ready_at=clock_timestamp()
    where candidate.tenant_id=${tenantId}::uuid and candidate.session_id=${sessionId}::uuid
      and candidate.state='queued' and candidate.ready_at is null
      and ${laneDependenciesReady(tenantId, sessionId, sql.ref("candidate.mailbox_position"))}
      and not exists(select 1 from subagent_executions child where child.child_run_id=candidate.id
        and child.state='preparing')`.execute(tx);
}
