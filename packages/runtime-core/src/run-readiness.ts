import type { Database } from "@pi-cloud/database";
import { sql, type RawBuilder, type Transaction } from "kysely";

/** Evaluated by input acceptance or seal projection under the Lane row lock. */
export function laneDependenciesReady(
  tenantId: string,
  sessionId: string,
  mailbox: RawBuilder<unknown>,
): RawBuilder<boolean> {
  return sql<boolean>`exists(select 1 from sessions s where s.tenant_id=${tenantId}::uuid
      and s.id=${sessionId}::uuid and s.state in ('cold','idle') and s.pruned_at is null)
    and not exists(select 1 from runs prior where prior.tenant_id=${tenantId}::uuid
      and prior.session_id=${sessionId}::uuid and prior.mailbox_position<${mailbox}
      and (prior.state not in ('completed','failed','cancelled','timed_out') or prior.recovery_requested_at is not null))
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
      and ${laneDependenciesReady(tenantId, sessionId, sql.ref("candidate.mailbox_position"))}`.execute(
    tx,
  );
}

/** Native Inbox/compaction targets the current work, even when later scheduled
 * Runs have already entered the cloud queue. Three indexed candidates suffice. */
export function receivingConversationRunId(
  tenantId: string,
  sessionId: string,
): RawBuilder<string | null> {
  return sql<string | null>`coalesce(
    (select id from runs where tenant_id=${tenantId}::uuid and session_id=${sessionId}::uuid and pruned_at is null
      and (state not in ('queued','completed','failed','cancelled','timed_out') or recovery_requested_at is not null or (output_seal_id is not null and output_sealed_at is null))
      order by mailbox_position limit 1),
    (select id from runs where tenant_id=${tenantId}::uuid and session_id=${sessionId}::uuid and pruned_at is null and state='queued' order by mailbox_position limit 1),
    (select id from runs where tenant_id=${tenantId}::uuid and session_id=${sessionId}::uuid and pruned_at is null order by mailbox_position desc limit 1)
  )`;
}
