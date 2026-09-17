import type { Database } from "@pi-cloud/database";
import {
  isTerminalRunAttemptState,
  isTerminalRunState,
  transitionRun,
  transitionRunAttempt,
  type RunAttemptState,
  type RunState,
} from "@pi-cloud/domain";
import { randomUUID } from "node:crypto";
import { parseExecutionReference } from "@pi-cloud/protocol";
import { sql, type Transaction } from "kysely";

class RunAttemptLifecycleError extends Error {
  readonly code: string;
  readonly retryable = false;

  constructor(code: string, message: string) {
    super(message);
    this.name = "RunAttemptLifecycleError";
    this.code = code;
  }
}

export type CurrentRunAttemptIdentity = {
  tenantId: string;
  runId: string;
  attemptId: string;
  executionReference?: string;
};

type RunAttemptFailure = {
  code: string;
  message: string;
  retryable: boolean;
};

export type RunAttemptTransitionInput = {
  runState: RunState;
  attemptState: RunAttemptState;
  reason: string;
  now: Date;
  failure?: RunAttemptFailure;
  stopReason?: string;
  claimExpiresAt?: Date;
  heartbeat?: boolean;
  transitionId?: string;
};

function expectOne(value: bigint, description: string): void {
  if (value !== 1n) {
    throw new RunAttemptLifecycleError(
      "run_attempt_stale",
      `${description} changed ${String(value)} rows`,
    );
  }
}

function validReason(value: string): string {
  if (value.length < 1 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new TypeError("Run attempt transition reason is invalid");
  }
  return value;
}

function validDate(value: Date, name: string): Date {
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError(`${name} must be a valid Date`);
  }
  return value;
}

function phaseTimestamp(state: RunAttemptState, now: Date): Record<string, Date> {
  switch (state) {
    case "provisioning":
      return { provisioning_at: now };
    case "restoring":
      return { restoring_at: now };
    case "running":
      return { running_at: now };
    case "settling":
      return { settling_at: now };
    default:
      return {};
  }
}

export async function transitionCurrentRunAttempt(
  transaction: Transaction<Database>,
  identity: CurrentRunAttemptIdentity,
  input: RunAttemptTransitionInput,
): Promise<void> {
  const now = validDate(input.now, "Run attempt transition clock");
  const reason = validReason(input.reason);
  const row = await transaction
    .selectFrom("runs as run")
    .innerJoin("run_attempts as attempt", (join) =>
      join
        .onRef("attempt.run_id", "=", "run.id")
        .onRef("attempt.id", "=", "run.current_attempt_id"),
    )
    .select([
      "run.state as runState",
      "run.row_version as runVersion",
      "run.current_attempt_id as currentAttemptId",
      "attempt.state as attemptState",
      "attempt.lease_id as executionReferenceId",
      "attempt.fencing_token as fencingToken",
    ])
    .where("run.tenant_id", "=", identity.tenantId)
    .where("run.id", "=", identity.runId)
    .where("attempt.id", "=", identity.attemptId)
    .forUpdate(["run", "attempt"])
    .executeTakeFirst();
  if (row === undefined || row.currentAttemptId !== identity.attemptId) {
    throw new RunAttemptLifecycleError("run_attempt_stale", "Run attempt is no longer current");
  }
  if (identity.executionReference !== undefined) {
    const grant = parseExecutionReference(identity.executionReference);
    if (
      grant.attemptId !== identity.attemptId ||
      row.executionReferenceId !== grant.leaseId ||
      Number(row.fencingToken) !== grant.fencingToken
    ) {
      throw new RunAttemptLifecycleError(
        "run_attempt_stale",
        "Run attempt ExecutionReference authority is stale",
      );
    }
  }

  const runState =
    row.runState === input.runState ? row.runState : transitionRun(row.runState, input.runState);
  const attemptState =
    row.attemptState === input.attemptState
      ? row.attemptState
      : transitionRunAttempt(row.attemptState, input.attemptState);
  const terminalRun = isTerminalRunState(runState);
  const terminalAttempt = isTerminalRunAttemptState(attemptState);
  const failureRequired = runState === "failed" || runState === "timed_out";
  if (failureRequired !== (input.failure !== undefined)) {
    throw new TypeError("Run failure metadata does not match its target state");
  }

  const attemptUpdate = transaction
    .updateTable("run_attempts")
    .set({
      state: attemptState,
      ...phaseTimestamp(attemptState, now),
      ...(input.claimExpiresAt === undefined ? {} : { claim_expires_at: input.claimExpiresAt }),
      ...(input.heartbeat === true ? { last_heartbeat_at: now } : {}),
      failure_code: input.failure?.code ?? null,
      failure_message: input.failure?.message ?? null,
      failure_retryable: input.failure?.retryable ?? null,
      settled_at: terminalAttempt ? now : null,
      updated_at: now,
    })
    .where("tenant_id", "=", identity.tenantId)
    .where("run_id", "=", identity.runId)
    .where("id", "=", identity.attemptId)
    .where("state", "=", row.attemptState)
    .returning("id");

  const runUpdate = transaction
    .updateTable("runs")
    .set({
      state: runState,
      ...(runState === "provisioning" ||
      runState === "restoring" ||
      runState === "running" ||
      runState === "settling" ||
      runState === "cancel_requested"
        ? { started_at: sql<Date>`coalesce(${sql.ref("started_at")}, ${now})` }
        : {}),
      stop_reason: input.stopReason ?? null,
      failure_code: input.failure?.code ?? null,
      failure_message: input.failure?.message ?? null,
      failure_retryable: input.failure?.retryable ?? null,
      settled_at: terminalRun ? now : null,
      row_version: sql<string>`${sql.ref("row_version")} + 1`,
      updated_at: now,
    })
    .where("tenant_id", "=", identity.tenantId)
    .where("id", "=", identity.runId)
    .where("current_attempt_id", "=", identity.attemptId)
    .where("state", "=", row.runState)
    .where("row_version", "=", row.runVersion)
    .returning("id");

  // The locked transition remains one transaction, but its three writes share
  // one server round trip. Count checks still roll back the entire transition.
  const changed = await transaction
    .with("updated_attempt", () => attemptUpdate)
    .with("updated_run", () => runUpdate)
    .with("recorded_transition", (db) =>
      db
        .insertInto("run_attempt_transitions")
        .columns([
          "id",
          "tenant_id",
          "run_id",
          "attempt_id",
          "from_state",
          "to_state",
          "reason",
          "occurred_at",
        ])
        .expression(
          db
            .selectFrom("updated_attempt")
            .select([
              sql<string>`${input.transitionId ?? randomUUID()}::uuid`.as("id"),
              sql<string>`${identity.tenantId}::uuid`.as("tenant_id"),
              sql<string>`${identity.runId}::uuid`.as("run_id"),
              "updated_attempt.id as attempt_id",
              sql`${row.attemptState}::text`.as("from_state"),
              sql`${attemptState}::text`.as("to_state"),
              sql<string>`${reason}::text`.as("reason"),
              sql<Date>`${now}::timestamptz`.as("occurred_at"),
            ])
            .where(sql<boolean>`${row.attemptState} <> ${attemptState}`),
        )
        .returning("id"),
    )
    .selectNoFrom([
      sql<number>`(select count(*)::int from updated_attempt)`.as("attempts"),
      sql<number>`(select count(*)::int from updated_run)`.as("runs"),
      sql<number>`(select count(*)::int from recorded_transition)`.as("transitions"),
    ])
    .executeTakeFirstOrThrow();
  expectOne(BigInt(changed.attempts), "Updating a run attempt");
  expectOne(BigInt(changed.runs), "Updating a run");
  if (changed.transitions !== Number(row.attemptState !== attemptState))
    throw new RunAttemptLifecycleError(
      "run_attempt_stale",
      "Run transition record was not committed",
    );
}
