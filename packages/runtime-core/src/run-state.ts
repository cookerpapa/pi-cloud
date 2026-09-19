import type { Database } from "@pi-cloud/database";
import { isTerminalRunState, transitionRun, type RunState } from "@pi-cloud/domain";
import { parseExecutionReference } from "@pi-cloud/protocol";
import { randomUUID } from "node:crypto";
import { sql, type Transaction } from "kysely";

export type RunIdentity = { tenantId: string; runId: string; executionReference?: string };
export type RunTransitionInput = {
  runState: RunState;
  reason: string;
  now: Date;
  failure?: { code: string; message: string; retryable: boolean };
  stopReason?: string;
  heartbeat?: boolean;
  transitionId?: string;
};

export async function transitionCurrentRun(
  tx: Transaction<Database>,
  identity: RunIdentity,
  input: RunTransitionInput,
): Promise<void> {
  const row = await tx
    .selectFrom("runs")
    .select(["state", "row_version", "lease_id", "fencing_token"])
    .where("tenant_id", "=", identity.tenantId)
    .where("id", "=", identity.runId)
    .forNoKeyUpdate()
    .executeTakeFirstOrThrow();
  if (identity.executionReference) {
    const ref = parseExecutionReference(identity.executionReference);
    if (
      ref.runId !== identity.runId ||
      ref.leaseId !== row.lease_id ||
      ref.fencingToken !== Number(row.fencing_token)
    )
      throw new Error("Run execution authority changed");
  }
  const state = row.state === input.runState ? row.state : transitionRun(row.state, input.runState);
  const changed = await tx
    .with("updated_run", (q) =>
      q
        .updateTable("runs")
        .set({
          state,
          row_version: sql<string>`row_version+1`,
          updated_at: input.now,
          ...(isTerminalRunState(state) ? { settled_at: input.now } : {}),
          ...(input.heartbeat ? { last_heartbeat_at: input.now } : {}),
          ...(input.stopReason ? { stop_reason: input.stopReason } : {}),
          ...(input.failure
            ? {
                failure_code: input.failure.code,
                failure_message: input.failure.message,
                failure_retryable: input.failure.retryable,
              }
            : {}),
        })
        .where("tenant_id", "=", identity.tenantId)
        .where("id", "=", identity.runId)
        .where("row_version", "=", row.row_version)
        .returning("id"),
    )
    .with("recorded_transition", (q) =>
      q
        .insertInto("run_transitions")
        .columns(["id", "tenant_id", "run_id", "from_state", "to_state", "reason", "occurred_at"])
        .expression((q) =>
          q
            .selectFrom("updated_run")
            .select([
              sql<string>`${input.transitionId ?? randomUUID()}::uuid`.as("id"),
              sql<string>`${identity.tenantId}::uuid`.as("tenant_id"),
              "updated_run.id as run_id",
              sql`${row.state}::text`.as("from_state"),
              sql`${state}::text`.as("to_state"),
              sql`${input.reason}::text`.as("reason"),
              sql<Date>`${input.now}::timestamptz`.as("occurred_at"),
            ])
            .where(sql<boolean>`${row.state}<>${state}`),
        )
        .returning("id"),
    )
    .selectNoFrom([
      sql<number>`(select count(*)::int from updated_run)`.as("runs"),
      sql<number>`(select count(*)::int from recorded_transition)`.as("transitions"),
    ])
    .executeTakeFirstOrThrow();
  if (changed.runs !== 1 || changed.transitions !== Number(row.state !== state))
    throw new Error("Run transition did not commit exactly once");
}
