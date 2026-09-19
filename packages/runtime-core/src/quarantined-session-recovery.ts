import type { Database } from "@pi-cloud/database";
import { retryTransaction } from "@pi-cloud/database";
import { transitionSession } from "@pi-cloud/domain";
import { sql, type Kysely, type Transaction } from "kysely";
import { advanceLaneReadiness } from "./run-readiness.ts";

type Execution = { tenantId: string; sessionId: string; runId: string; attemptId: string };

/** Call after recording either exit or seal, in the same transaction. Neither
 * lease release nor a Kafka seal proves that the Agent Loop itself stopped. */
export async function recoverQuarantinedSession(
  tx: Transaction<Database>,
  execution: Execution,
): Promise<void> {
  const recovered = await tx
    .updateTable("sessions as s")
    .set({
      state: transitionSession(transitionSession("failed", "recovering"), "idle"),
      row_version: sql<string>`s.row_version + 1`,
      updated_at: sql<Date>`now()`,
    })
    .where("s.tenant_id", "=", execution.tenantId)
    .where("s.id", "=", execution.sessionId)
    .where("s.state", "=", "failed")
    .where("s.archived_at", "is", null)
    .where(
      sql<boolean>`exists (
      select 1 from runs r join run_attempts a on a.id=r.current_attempt_id
      where r.tenant_id=s.tenant_id and r.session_id=s.id
        and r.id=${execution.runId}::uuid and a.id=${execution.attemptId}::uuid
        and r.state in ('failed','timed_out','cancelled')
        and a.agent_exited_at is not null and a.output_sealed_at is not null
        and not exists(select 1 from runs later where later.session_id=s.id
          and later.mailbox_position>r.mailbox_position and later.state<>'queued')
    )`,
    )
    .where(
      sql<boolean>`not exists (
      select 1 from runs r where r.tenant_id=s.tenant_id and r.session_id=s.id
        and r.state in ('claimed','provisioning','restoring','running','settling','cancel_requested')
    )`,
    )
    .where(
      sql<boolean>`not exists (
      select 1 from run_attempts a join runs r on r.id=a.run_id
      where r.tenant_id=s.tenant_id and r.session_id=s.id
        and a.output_seal_id is not null and a.output_sealed_at is null
    )`,
    )
    .executeTakeFirst();
  if (recovered.numUpdatedRows > 0n) {
    await advanceLaneReadiness(tx, execution.tenantId, execution.sessionId);
  }
}

/** Only the local settled Runner or a positively confirmed stopped Worker may
 * call this. A disconnected management endpoint is not sufficient evidence. */
export async function confirmAgentExit(db: Kysely<Database>, execution: Execution): Promise<void> {
  await retryTransaction(db, async (tx) => {
    const updated = await tx
      .updateTable("run_attempts")
      .set({ agent_exited_at: sql<Date>`coalesce(agent_exited_at, now())` })
      .where("tenant_id", "=", execution.tenantId)
      .where("run_id", "=", execution.runId)
      .where("id", "=", execution.attemptId)
      .returning("id")
      .executeTakeFirst();
    if (updated) await recoverQuarantinedSession(tx, execution);
  });
}

export async function confirmStoppedWorkerExecutions(db: Kysely<Database>, sandboxId: string) {
  const attempts = await db
    .selectFrom("run_attempts as a")
    .innerJoin("runs as r", "r.id", "a.run_id")
    .select([
      "a.tenant_id as tenantId",
      "r.session_id as sessionId",
      "r.id as runId",
      "a.id as attemptId",
    ])
    .where("a.sandbox_id", "=", sandboxId)
    .where("a.agent_exited_at", "is", null)
    .where("a.state", "in", ["failed", "cancelled", "timed_out"])
    .execute();
  for (const attempt of attempts) await confirmAgentExit(db, attempt);
}
