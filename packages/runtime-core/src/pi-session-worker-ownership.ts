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
      join run_attempts as writer on writer.id=peer_attempt.native_writer_id
     where peer_session.tenant_id = ${tenantId}
       and peer_session.pi_session_id = ${piSessionId}
       and peer_run.state in (
         'claimed', 'provisioning', 'restoring', 'running', 'settling', 'cancel_requested'
       )
       and peer_attempt.state in (
         'claimed', 'provisioning', 'restoring', 'running', 'settling', 'cancel_requested'
       )
       and (peer_attempt.claim_expires_at <= ${now}
         or peer_attempt.claim_owner_id <> ${expectedWorkerId}
         or writer.native_writer_failed_at is not null or writer.native_writer_sealed_at is not null)
  ) and not exists (
    select 1 from sessions s join runs r on r.session_id=s.id join run_attempts a on a.run_id=r.id
    where s.tenant_id=${tenantId} and s.pi_session_id=${piSessionId}
      and a.output_seal_id is not null and a.output_sealed_at is null
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

/** Called under the physical Session row lock. A writer is an append-log
 * incarnation identified by its first Attempt, not another lease/heartbeat. */
export async function selectNativeSessionWriter(
  transaction: Transaction<Database>,
  input: {
    tenantId: string;
    piSessionId: string;
    runId: string;
    workerId: string;
    attemptId: string;
    now: Date;
  },
): Promise<string | undefined> {
  const peers = await transaction
    .selectFrom("sessions as s")
    .innerJoin("runs as r", "r.session_id", "s.id")
    .innerJoin("run_attempts as a", "a.id", "r.current_attempt_id")
    .select(["a.native_writer_id", "a.claim_owner_id", "a.claim_expires_at"])
    .where("s.tenant_id", "=", input.tenantId)
    .where("s.pi_session_id", "=", input.piSessionId)
    .where("r.id", "!=", input.runId)
    .where("r.state", "in", [...ACTIVE_RUN_STATES])
    .execute();
  let writerId = input.attemptId;
  if (peers.length) {
    if (peers.some((p) => p.claim_owner_id !== input.workerId || p.claim_expires_at <= input.now))
      return undefined;
    writerId = peers[0]!.native_writer_id!;
    if (!writerId || peers.some((p) => p.native_writer_id !== writerId))
      throw new PiSessionWorkerOwnershipError("Active Lanes disagree on native writer identity");
    const writer = await transaction
      .selectFrom("run_attempts")
      .select(["native_writer_failed_at", "native_writer_sealed_at"])
      .where("id", "=", writerId)
      .executeTakeFirstOrThrow();
    if (writer.native_writer_failed_at || writer.native_writer_sealed_at) return undefined;
  } else {
    const pending = await transaction
      .selectFrom("sessions as s")
      .innerJoin("runs as r", "r.session_id", "s.id")
      .innerJoin("run_attempts as a", "a.run_id", "r.id")
      .select("a.id")
      .where("s.tenant_id", "=", input.tenantId)
      .where("s.pi_session_id", "=", input.piSessionId)
      .where("a.output_seal_id", "is not", null)
      .where("a.output_sealed_at", "is", null)
      .limit(1)
      .executeTakeFirst();
    if (pending) return undefined;
  }
  await transaction
    .updateTable("pi_sessions")
    .set({ active_writer_id: writerId })
    .where("tenant_id", "=", input.tenantId)
    .where("id", "=", input.piSessionId)
    .executeTakeFirstOrThrow();
  return writerId;
}
