import type { Database } from "@pi-cloud/database";
import {
  releaseExecutionScope,
  releaseIdleSessionLease,
} from "@pi-cloud/runtime-core/session-lease-release";
import { databaseTime, retryTransaction } from "@pi-cloud/database";
import {
  transitionSandbox,
  transitionSession,
  transitionTurn,
  type SandboxState,
} from "@pi-cloud/domain";
import type {
  SandboxAssignmentInventory,
  SandboxRuntimeAssignment,
} from "@pi-cloud/sandbox-supervisor/sandbox-assignment-inventory";
import { sql, type Kysely, type Transaction } from "kysely";
import { randomUUID } from "node:crypto";
import { transitionCurrentRun } from "@pi-cloud/runtime-core/run-state";
import { requestExecutionStreamSeal } from "@pi-cloud/runtime-core/execution-stream-seal";
import { createExecutionReference, parseExecutionReference } from "@pi-cloud/protocol";

const ASSIGNMENT_LOST = "assignment_lost";
const ASSIGNMENT_LOST_MESSAGE =
  "The Worker lost its active Run assignment before durable completion";
const DEFAULT_RECONCILIATION_LIMIT = 100;

const ACTIVE_SESSION_STATES = new Set(["starting", "running", "cancelling"]);
const ACTIVE_TURN_STATES = new Set(["running", "cancelling"]);

export type AssignmentReconcilerOptions = {
  database: Kysely<Database>;
  sandboxId: string;
  inventory: SandboxAssignmentInventory;
  clock?: () => Date;
};

export type AssignmentReconciliationResult = {
  inspectedRuntimes: number;
  terminatedRuntimes: number;
  orphanRuntimes: number;
  settledAssignments: number;
};

export type SandboxRetirementResult = AssignmentReconciliationResult & {
  sandboxState: "terminated";
};

export class AssignmentReconcilerError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable: boolean) {
    super(safeMessage);
    this.name = "AssignmentReconcilerError";
    this.code = code;
    this.retryable = retryable;
  }
}

type DurableAssignment = {
  sessionId: string;
  executionReference: string;
  validUntil: Date;
  runId: string;
  turnId: string;
};

type Finalization = "settled" | "released" | "skipped";

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

function validDate(clock: () => Date): Date {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) {
    throw new TypeError("assignment reconciler clock must return a valid Date");
  }
  return value;
}

function safeInteger(value: string | number | bigint, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AssignmentReconcilerError(
      "assignment_invariant",
      `${name} is outside the supported integer range`,
      false,
    );
  }
  return parsed;
}

function sameLease(runtime: SandboxRuntimeAssignment, durable: DurableAssignment): boolean {
  return (
    runtime.sessionId === durable.sessionId &&
    runtime.executionReference === durable.executionReference
  );
}

function sameAssignment(runtime: SandboxRuntimeAssignment, durable: DurableAssignment): boolean {
  return (
    sameLease(runtime, durable) &&
    durable.runId.length > 0 &&
    runtime.runId === durable.runId &&
    runtime.turnId === durable.turnId
  );
}

function emptyResult(inspectedRuntimes: number): AssignmentReconciliationResult {
  return {
    inspectedRuntimes,
    terminatedRuntimes: 0,
    orphanRuntimes: 0,
    settledAssignments: 0,
  };
}

/**
 * Reconciles a sandbox only after its owning supervisor boot has been fenced
 * by the caller and can no longer create a runtime for an observed command.
 * Runtime absence is not a substitute for that supervisor-liveness decision.
 */
export class AssignmentReconciler {
  readonly #database: Kysely<Database>;
  readonly #sandboxId: string;
  readonly #inventory: SandboxAssignmentInventory;
  readonly #clock: () => Date;

  constructor(options: AssignmentReconcilerOptions) {
    if (options.sandboxId.trim().length === 0) {
      throw new TypeError("sandboxId must not be empty");
    }
    this.#database = options.database;
    this.#sandboxId = options.sandboxId;
    this.#inventory = options.inventory;
    this.#clock = options.clock ?? (() => new Date());
  }

  /** An expired Session lease retires every task of that owner incarnation.
   * Do not kill unrelated families on a healthy Worker; late effects meet the
   * ordered closure. The limit counts families, never individual child tasks. */
  async retireExpiredAssignments(
    limit = DEFAULT_RECONCILIATION_LIMIT,
  ): Promise<AssignmentReconciliationResult> {
    const now = await databaseTime(this.#database),
      result = emptyResult(0);
    await this.#releaseIdleFamilies(now);
    const expired = await this.#loadDurableAssignments(true);
    const families = new Set(
      [...new Set(expired.map((a) => parseExecutionReference(a.executionReference).leaseId))].slice(
        0,
        positiveInteger(limit, "limit"),
      ),
    );
    const targets = expired.filter((a) =>
      families.has(parseExecutionReference(a.executionReference).leaseId),
    );
    for (const target of targets) {
      const finalized = await retryTransaction(this.#database, async (tx) => {
        const outcome = await this.#finalizeLease(tx, target, true);
        return outcome;
      });
      if (finalized !== "skipped") result.settledAssignments++;
    }
    return result;
  }

  async retireSandbox(): Promise<SandboxRetirementResult> {
    const now = validDate(this.#clock);
    try {
      await this.#beginRetirement(now);
      const runtimes = await this.#inventory.listAssignments();
      const sandbox = await this.#loadSandboxIdentity();
      this.#assertRuntimeScope(runtimes, sandbox);
      const durableAssignments = await this.#loadDurableAssignments();
      const orphans = runtimes.filter(
        (runtime) => !durableAssignments.some((assignment) => sameAssignment(runtime, assignment)),
      );
      for (const runtime of runtimes) {
        await this.#inventory.terminateAndConfirmAbsent(runtime);
      }

      const result = emptyResult(runtimes.length);
      result.terminatedRuntimes = runtimes.length;
      result.orphanRuntimes = orphans.length;
      return await this.#finalizeRetirement(durableAssignments, result, now);
    } catch (error: unknown) {
      await this.#quarantineSandbox(now).catch(() => undefined);
      throw this.#normalizeError(error);
    }
  }

  /**
   * Finalizes only durable state after the owner connection, Sandbox and lease
   * have already been fenced but the dead/partitioned process has no reachable
   * management endpoint. No runtime is adopted or assumed to be reusable.
   */
  async retireFencedSandbox(): Promise<SandboxRetirementResult> {
    const now = validDate(this.#clock);
    try {
      await this.#beginRetirement(now);
      return await this.#finalizeRetirement(
        await this.#loadDurableAssignments(),
        emptyResult(0),
        now,
      );
    } catch (error: unknown) {
      await this.#quarantineSandbox(now).catch(() => undefined);
      throw this.#normalizeError(error);
    }
  }

  async #loadSandboxIdentity(): Promise<{
    supervisorId: string;
    bootId: string;
    state: SandboxState;
  }> {
    const sandbox = await this.#database
      .selectFrom("sandboxes")
      .select(["supervisor_id", "boot_id", "state"])
      .where("id", "=", this.#sandboxId)
      .executeTakeFirst();
    if (sandbox === undefined) {
      throw new AssignmentReconcilerError(
        "sandbox_unavailable",
        "Reconciliation sandbox was unavailable",
        false,
      );
    }
    return {
      supervisorId: sandbox.supervisor_id,
      bootId: sandbox.boot_id,
      state: sandbox.state,
    };
  }

  #assertRuntimeScope(
    runtimes: readonly SandboxRuntimeAssignment[],
    sandbox: { supervisorId: string; bootId: string },
  ): void {
    for (const runtime of runtimes) {
      if (
        runtime.sandboxId !== this.#sandboxId ||
        runtime.supervisorId !== sandbox.supervisorId ||
        runtime.bootId !== sandbox.bootId
      ) {
        throw new AssignmentReconcilerError(
          "runtime_identity_mismatch",
          "Observed runtime identity did not match its durable sandbox",
          false,
        );
      }
    }
  }

  async #loadDurableAssignments(expiredOnly = false): Promise<DurableAssignment[]> {
    const grants = await this.#database
      .selectFrom("active_execution_scopes")
      .select([
        "session_id",
        "lease_id",
        "run_id",
        "fencing_token",
        "valid_until",
        "turn_id",
      ])
      .where("sandbox_id", "=", this.#sandboxId)
      .where(sql<boolean>`(${!expiredOnly} or valid_until <= clock_timestamp())`)
      .orderBy("valid_until", "asc")
      .execute();
    return grants.map((grant) => ({
      sessionId: grant.session_id,
      executionReference: createExecutionReference(
        grant.lease_id,
        grant.run_id,
        safeInteger(grant.fencing_token, "fencing token"),
      ),
      validUntil: new Date(grant.valid_until),
      runId: grant.run_id,
      turnId: grant.turn_id,
    }));
  }

  async #finalizeLease(
    transaction: Transaction<Database>,
    candidate: DurableAssignment,
    requireExpired: boolean,
  ): Promise<Finalization> {
    const execution = parseExecutionReference(candidate.executionReference);
    // Match lifecycle lock order before touching the lease. A stale candidate
    // must not hold a new owner's lease while waiting for its Run rows.
    const current = await transaction
      .selectFrom("turns as turn")
      .innerJoin("sessions as session", "session.id", "turn.session_id")
      .innerJoin("runs as run", "run.turn_id", "turn.id")
      .select(["run.id", "session.tenant_id", "session.pi_session_id"])
      .where("turn.id", "=", candidate.turnId)
      .where("session.id", "=", candidate.sessionId)
      .where("run.id", "=", candidate.runId)
      .where("run.id", "=", execution.runId)
      .forNoKeyUpdate(["turn", "session", "run"])
      .executeTakeFirst();
    if (!current) return "skipped";
    await transaction
      .selectFrom("pi_sessions")
      .select("id")
      .where("tenant_id", "=", current.tenant_id)
      .where("id", "=", current.pi_session_id)
      .forUpdate()
      .executeTakeFirstOrThrow();
    await transaction
      .selectFrom("sandboxes")
      .select("id")
      .where("id", "=", this.#sandboxId)
      .forNoKeyUpdate()
      .executeTakeFirstOrThrow();
    await transaction
      .selectFrom("session_leases")
      .select("lease_id")
      .where("lease_id", "=", execution.leaseId)
      .forNoKeyUpdate()
      .execute();
    const grant = await transaction
      .selectFrom("active_execution_scopes")
      .select(["lease_id", "run_id", "sandbox_id", "fencing_token", "valid_until"])
      .where("session_id", "=", candidate.sessionId)
      .where(sql<boolean>`(${!requireExpired} or valid_until <= clock_timestamp())`)
      .executeTakeFirst();
    if (
      grant === undefined ||
      grant.lease_id !== execution.leaseId ||
      grant.run_id !== execution.runId ||
      grant.sandbox_id !== this.#sandboxId ||
      safeInteger(grant.fencing_token, "final fencing token") !== execution.fencingToken
    ) {
      return "skipped";
    }
    const now = await databaseTime(transaction);

    const session = await transaction
      .selectFrom("sessions")
      .select(["tenant_id", "state"])
      .where("id", "=", candidate.sessionId)
      .forUpdate()
      .executeTakeFirstOrThrow();
    const turns = await transaction
      .selectFrom("turns")
      .select(["id", "state"])
      .where("session_id", "=", candidate.sessionId)
      .where("id", "=", candidate.turnId)
      .where("state", "in", ["queued", "running", "cancelling"])
      .forUpdate()
      .execute();
    if (turns.length > 1) {
      throw new AssignmentReconcilerError(
        "assignment_invariant",
        "Session had multiple active turns while finalizing an assignment",
        false,
      );
    }
    const turn = turns[0];
    if (turn === undefined) {
      if (ACTIVE_SESSION_STATES.has(session.state)) {
        throw new AssignmentReconcilerError(
          "assignment_invariant",
          "Active session had no active turn during reconciliation",
          false,
        );
      }
      await this.#deleteLease(transaction, candidate, now);
      return "released";
    }

    const run = await transaction
      .selectFrom("runs as run")
      .select(["run.id as runId", "run.state as runState", "run.row_version as runVersion"])
      .where("run.tenant_id", "=", session.tenant_id)
      .where("run.session_id", "=", candidate.sessionId)
      .where("run.turn_id", "=", turn.id)
      .where("run.id", "=", candidate.runId)
      .forNoKeyUpdate("run")
      .executeTakeFirstOrThrow();

    if (!ACTIVE_SESSION_STATES.has(session.state) || !ACTIVE_TURN_STATES.has(turn.state)) {
      throw new AssignmentReconcilerError(
        "assignment_invariant",
        "Acknowledged assignment lifecycle was inconsistent",
        false,
      );
    }
    await transitionCurrentRun(
      transaction,
      {
        tenantId: session.tenant_id,
        runId: run.runId,
      },
      {
        runState: "failed",
        reason: "assignment_lost_after_ack",
        now,
        failure: {
          code: ASSIGNMENT_LOST,
          message: ASSIGNMENT_LOST_MESSAGE,
          retryable: false,
        },
        transitionId: randomUUID(),
      },
    );
    await transaction
      .updateTable("model_requests")
      .set({
        state: "failed",
        failure_code: ASSIGNMENT_LOST,
        settled_at: now,
      })
      .where("tenant_id", "=", session.tenant_id)
      .where("run_id", "=", run.runId)
      .where("state", "=", "reserved")
      .execute();
    await transaction
      .updateTable("turn_control_requests")
      .set({ state: "failed", completed_at: now, failure_code: ASSIGNMENT_LOST })
      .where("tenant_id", "=", session.tenant_id)
      .where("target_run_id", "=", run.runId)
      .where("state", "in", ["pending", "dispatched", "acknowledged"])
      .execute();
    await transaction
      .updateTable("turns")
      .set({
        state: transitionTurn(turn.state, "failed"),
        failure_code: ASSIGNMENT_LOST,
        failure_message: ASSIGNMENT_LOST_MESSAGE,
        failure_retryable: false,
        settled_at: now,
      })
      .where("id", "=", turn.id)
      .where("state", "=", turn.state)
      .executeTakeFirstOrThrow();
    await transaction
      .updateTable("sessions")
      .set({
        state: transitionSession(session.state, "idle"),
        row_version: sql<string>`${sql.ref("row_version")} + 1`,
        updated_at: now,
        last_active_at: now,
      })
      .where("id", "=", candidate.sessionId)
      .where("state", "=", session.state)
      .executeTakeFirstOrThrow();
    const terminalEventId = randomUUID();
    const terminalBody = {
      type: "turn.failed",
      payload: {
        code: ASSIGNMENT_LOST,
        message: ASSIGNMENT_LOST_MESSAGE,
        retryable: false,
      },
    } as const;

    await requestExecutionStreamSeal(transaction, {
      tenantId: session.tenant_id,
      sessionId: candidate.sessionId,
      turnId: turn.id,
      runId: run.runId,
      agentId: "root",
      body: terminalBody,
      now,
      eventId: terminalEventId,
    });
    await this.#deleteLease(transaction, candidate, now);
    return "settled";
  }

  async #deleteLease(
    tx: Transaction<Database>,
    assignment: DurableAssignment,
    now: Date,
  ): Promise<void> {
    const ref = parseExecutionReference(assignment.executionReference);
    const row = await tx
      .selectFrom("runs")
      .select("tenant_id")
      .where("id", "=", assignment.runId)
      .executeTakeFirstOrThrow();
    await releaseExecutionScope(tx, {
      tenantId: row.tenant_id,
      runId: ref.runId,
      leaseId: ref.leaseId,
      fencingToken: ref.fencingToken,
      now,
    });
  }

  async #releaseIdleFamilies(now: Date): Promise<void> {
    const leases = await this.#database
      .selectFrom("session_leases")
      .selectAll()
      .where("sandbox_id", "=", this.#sandboxId)
      .where("released_at", "is", null)
      .execute();
    for (const lease of leases)
      await retryTransaction(this.#database, async (tx) => {
        await tx
          .selectFrom("pi_sessions")
          .select("id")
          .where("tenant_id", "=", lease.tenant_id)
          .where("id", "=", lease.pi_session_id)
          .forUpdate()
          .executeTakeFirst();
        await releaseIdleSessionLease(tx, lease.lease_id, now);
      });
  }

  async #finalizeRetirement(
    assignments: readonly DurableAssignment[],
    result: AssignmentReconciliationResult,
    now: Date,
  ): Promise<SandboxRetirementResult> {
    await this.#database.transaction().execute(async (transaction) => {
      for (const assignment of assignments) {
        const finalized = await this.#finalizeLease(transaction, assignment, false);
        if (finalized === "settled" || finalized === "released") {
          result.settledAssignments += 1;
        }
      }
      const remaining = await transaction
        .selectFrom("active_execution_scopes")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("sandbox_id", "=", this.#sandboxId)
        .executeTakeFirstOrThrow();
      if (safeInteger(remaining.count, "remaining sandbox lease count") !== 0) {
        throw new AssignmentReconcilerError(
          "assignment_reconciliation_incomplete",
          "Sandbox retirement retained an assignment",
          true,
        );
      }
      const row = await transaction
        .selectFrom("sandboxes")
        .select("state")
        .where("id", "=", this.#sandboxId)
        .forNoKeyUpdate()
        .executeTakeFirstOrThrow();
      if (row.state === "terminated") return;
      if (row.state !== "draining" && row.state !== "failed" && row.state !== "provisioning") {
        throw new AssignmentReconcilerError(
          "sandbox_retirement_invariant",
          "Sandbox was not fenced before retirement",
          false,
        );
      }
      await transaction
        .updateTable("sandboxes")
        .set({
          state: transitionSandbox(row.state, "terminated"),
          updated_at: now,
          terminated_at: now,
        })
        .where("id", "=", this.#sandboxId)
        .where("state", "=", row.state)
        .executeTakeFirstOrThrow();
    });
    return { ...result, sandboxState: "terminated" };
  }

  async #beginRetirement(now: Date): Promise<void> {
    await this.#database.transaction().execute(async (transaction) => {
      const sandbox = await transaction
        .selectFrom("sandboxes")
        .select(["state"])
        .where("id", "=", this.#sandboxId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (sandbox === undefined) {
        throw new AssignmentReconcilerError(
          "sandbox_unavailable",
          "Retirement sandbox was unavailable",
          false,
        );
      }
      if (
        sandbox.state === "terminated" ||
        sandbox.state === "draining" ||
        sandbox.state === "failed"
      ) {
        return;
      }
      const nextState =
        sandbox.state === "provisioning"
          ? transitionSandbox(sandbox.state, "failed")
          : transitionSandbox(sandbox.state, "draining");
      await transaction
        .updateTable("sandboxes")
        .set({ state: nextState, updated_at: now })
        .where("id", "=", this.#sandboxId)
        .where("state", "=", sandbox.state)
        .executeTakeFirstOrThrow();
    });
  }

  async #quarantineSandbox(now: Date): Promise<void> {
    await this.#database.transaction().execute(async (transaction) => {
      const sandbox = await transaction
        .selectFrom("sandboxes")
        .select(["state"])
        .where("id", "=", this.#sandboxId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (sandbox === undefined || sandbox.state === "failed" || sandbox.state === "terminated") {
        return;
      }
      await transaction
        .updateTable("sandboxes")
        .set({ state: transitionSandbox(sandbox.state, "failed"), updated_at: now })
        .where("id", "=", this.#sandboxId)
        .where("state", "=", sandbox.state)
        .executeTakeFirstOrThrow();
    });
  }

  #normalizeError(error: unknown): AssignmentReconcilerError {
    if (error instanceof AssignmentReconcilerError) return error;
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string" &&
      "retryable" in error &&
      typeof error.retryable === "boolean"
    ) {
      return new AssignmentReconcilerError(
        error.code,
        "Sandbox assignment reconciliation failed",
        error.retryable,
      );
    }
    return new AssignmentReconcilerError(
      "assignment_reconciliation_failed",
      "Sandbox assignment reconciliation failed",
      true,
    );
  }
}
