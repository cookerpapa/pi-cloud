import type { Database } from "@pi-cloud/database";
import { sql, type RawBuilder, type Transaction } from "kysely";

const ACTIVE_RUN_STATES = [
  "claimed",
  "provisioning",
  "restoring",
  "running",
  "settling",
  "cancel_requested",
] as const;

const ACTIVE_ATTEMPT_STATES = [
  "claimed",
  "provisioning",
  "restoring",
  "running",
  "settling",
  "cancel_requested",
] as const;

export class PiSessionWorkerOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PiSessionWorkerOwnershipError";
  }
}

/** Indexed read-side filter used before the common Session row is locked. */
export function piSessionWorkerAvailable(
  tenantId: RawBuilder<unknown>,
  piSessionId: RawBuilder<unknown>,
  expectedWorkerId: string,
  now: Date,
): RawBuilder<boolean> {
  return sql<boolean>`not exists (
    select 1
      from sessions as peer_session
      join runs as peer_run
        on peer_run.tenant_id = peer_session.tenant_id
       and peer_run.session_id = peer_session.id
      join run_attempts as peer_attempt
        on peer_attempt.tenant_id = peer_run.tenant_id
       and peer_attempt.run_id = peer_run.id
       and peer_attempt.id = peer_run.current_attempt_id
     where peer_session.tenant_id = ${tenantId}
       and peer_session.pi_session_id = ${piSessionId}
       and peer_run.state in (
         'claimed', 'provisioning', 'restoring', 'running', 'settling', 'cancel_requested'
       )
       and peer_attempt.state in (
         'claimed', 'provisioning', 'restoring', 'running', 'settling', 'cancel_requested'
       )
       and peer_attempt.claim_expires_at > ${now}
       and peer_attempt.claim_owner_id <> ${expectedWorkerId}
  )`;
}

/**
 * Serializes active-Worker selection for every Lane of one physical Pi Session.
 * The lock is held only by the caller's PostgreSQL transaction.
 */
export async function lockPiSessionWorkerOwnership(
  transaction: Transaction<Database>,
  tenantId: string,
  piSessionId: string,
): Promise<void> {
  const session = await transaction
    .selectFrom("pi_sessions")
    .select("id")
    .where("tenant_id", "=", tenantId)
    .where("id", "=", piSessionId)
    .forUpdate()
    .executeTakeFirst();
  if (session === undefined) {
    throw new PiSessionWorkerOwnershipError("Physical Pi Session was not found");
  }
}

/** Returns the other live Worker that already owns an active Lane, if any. */
export async function conflictingPiSessionWorker(
  transaction: Transaction<Database>,
  input: Readonly<{
    tenantId: string;
    piSessionId: string;
    expectedWorkerId: string;
    now: Date;
  }>,
): Promise<string | undefined> {
  const conflict = await transaction
    .selectFrom("sessions as scope")
    .innerJoin("runs as run", (join) =>
      join.onRef("run.tenant_id", "=", "scope.tenant_id").onRef("run.session_id", "=", "scope.id"),
    )
    .innerJoin("run_attempts as attempt", (join) =>
      join
        .onRef("attempt.tenant_id", "=", "run.tenant_id")
        .onRef("attempt.run_id", "=", "run.id")
        .onRef("attempt.id", "=", "run.current_attempt_id"),
    )
    .select("attempt.claim_owner_id as ownerId")
    .where("scope.tenant_id", "=", input.tenantId)
    .where("scope.pi_session_id", "=", input.piSessionId)
    .where("run.state", "in", [...ACTIVE_RUN_STATES])
    .where("attempt.state", "in", [...ACTIVE_ATTEMPT_STATES])
    .where("attempt.claim_expires_at", ">", input.now)
    .where("attempt.claim_owner_id", "!=", input.expectedWorkerId)
    .limit(1)
    .executeTakeFirst();
  return conflict?.ownerId;
}
