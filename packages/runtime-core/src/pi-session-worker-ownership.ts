import type { Database } from "@pi-cloud/database";
import { sql, type RawBuilder, type Transaction } from "kysely";

const ACTIVE_STATES = [
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

/** One owner lease governs every Lane. Unbound queue claims only cover startup. */
export function piSessionWorkerAvailable(
  tenantId: RawBuilder<unknown>,
  piSessionId: RawBuilder<unknown>,
  expectedWorkerId: string,
  now: Date,
  candidateRunId?: RawBuilder<unknown>,
): RawBuilder<boolean> {
  return sql<boolean>`not exists(
    select 1 from session_leases l join run_attempts w on w.id=l.writer_id
     where l.tenant_id=${tenantId} and l.pi_session_id=${piSessionId}
       and (l.valid_until<=${now} or w.claim_owner_id<>${expectedWorkerId}
         or w.native_writer_failed_at is not null or w.native_writer_sealed_at is not null)
  ) and not exists(
    select 1 from sessions s join runs r on r.session_id=s.id join run_attempts a on a.id=r.current_attempt_id
     where s.tenant_id=${tenantId} and s.pi_session_id=${piSessionId}
       and a.lease_id is null and a.state in ('claimed','provisioning','restoring','running','settling','cancel_requested')
       and r.state in ('claimed','provisioning','restoring','running','settling','cancel_requested')
       and ${candidateRunId ? sql`r.id<>${candidateRunId}` : sql`true`}
       and (a.claim_expires_at<=${now} or a.claim_owner_id<>${expectedWorkerId})
  ) and (
    exists(select 1 from session_leases l where l.tenant_id=${tenantId} and l.pi_session_id=${piSessionId})
    or not exists(select 1 from sessions s join runs r on r.session_id=s.id join run_attempts a on a.run_id=r.id
      where s.tenant_id=${tenantId} and s.pi_session_id=${piSessionId}
        and a.output_seal_id is not null and a.output_sealed_at is null)
  )`;
}
export async function lockPiSessionWorkerOwnership(
  tx: Transaction<Database>,
  tenantId: string,
  piSessionId: string,
): Promise<void> {
  const row = await tx
    .selectFrom("pi_sessions")
    .select("id")
    .where("tenant_id", "=", tenantId)
    .where("id", "=", piSessionId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw new PiSessionWorkerOwnershipError("Physical Pi Session was not found");
}
export async function conflictingPiSessionWorker(
  tx: Transaction<Database>,
  input: {
    tenantId: string;
    piSessionId: string;
    expectedWorkerId: string;
    now: Date;
  },
): Promise<string | undefined> {
  const owner = await tx
    .selectFrom("session_leases as l")
    .innerJoin("run_attempts as w", "w.id", "l.writer_id")
    .select("w.claim_owner_id")
    .where("l.tenant_id", "=", input.tenantId)
    .where("l.pi_session_id", "=", input.piSessionId)
    .where("l.valid_until", ">", input.now)
    .where("w.claim_owner_id", "!=", input.expectedWorkerId)
    .executeTakeFirst();
  if (owner) return owner.claim_owner_id;
  const pending = await tx
    .selectFrom("sessions as s")
    .innerJoin("runs as r", "r.session_id", "s.id")
    .innerJoin("run_attempts as a", "a.id", "r.current_attempt_id")
    .select("a.claim_owner_id")
    .where("s.tenant_id", "=", input.tenantId)
    .where("s.pi_session_id", "=", input.piSessionId)
    .where("a.lease_id", "is", null)
    .where("a.state", "in", [...ACTIVE_STATES])
    .where("a.claim_expires_at", ">", input.now)
    .where("a.claim_owner_id", "!=", input.expectedWorkerId)
    .limit(1)
    .executeTakeFirst();
  return pending?.claim_owner_id;
}

export async function selectNativeSessionWriter(
  tx: Transaction<Database>,
  input: {
    tenantId: string;
    piSessionId: string;
    runId: string;
    workerId: string;
    attemptId: string;
    now: Date;
  },
): Promise<string | undefined> {
  const lease = await tx
    .selectFrom("session_leases as l")
    .innerJoin("run_attempts as w", "w.id", "l.writer_id")
    .select([
      "l.writer_id",
      "l.valid_until",
      "w.claim_owner_id",
      "w.native_writer_failed_at",
      "w.native_writer_sealed_at",
    ])
    .where("l.tenant_id", "=", input.tenantId)
    .where("l.pi_session_id", "=", input.piSessionId)
    .executeTakeFirst();
  let writerId = input.attemptId;
  if (lease) {
    if (
      lease.claim_owner_id !== input.workerId ||
      lease.valid_until <= input.now ||
      lease.native_writer_failed_at ||
      lease.native_writer_sealed_at
    )
      return undefined;
    writerId = lease.writer_id;
  } else {
    const peers = await tx
      .selectFrom("sessions as s")
      .innerJoin("runs as r", "r.session_id", "s.id")
      .innerJoin("run_attempts as a", "a.id", "r.current_attempt_id")
      .select(["a.native_writer_id", "a.claim_owner_id", "a.claim_expires_at"])
      .where("s.tenant_id", "=", input.tenantId)
      .where("s.pi_session_id", "=", input.piSessionId)
      .where("r.id", "!=", input.runId)
      .where("r.state", "in", [...ACTIVE_STATES])
      .execute();
    if (peers.length) {
      if (peers.some((p) => p.claim_owner_id !== input.workerId || p.claim_expires_at <= input.now))
        return undefined;
      writerId = peers[0]!.native_writer_id!;
      if (!writerId || peers.some((p) => p.native_writer_id !== writerId))
        throw new PiSessionWorkerOwnershipError(
          "Session startup claims disagree on writer identity",
        );
    }
    const pending = await tx
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
  await tx
    .updateTable("pi_sessions")
    .set({ active_writer_id: writerId })
    .where("tenant_id", "=", input.tenantId)
    .where("id", "=", input.piSessionId)
    .executeTakeFirstOrThrow();
  return writerId;
}
