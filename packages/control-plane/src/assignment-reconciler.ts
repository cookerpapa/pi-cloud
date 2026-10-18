import type { Database } from "@pi-cloud/database";
import { releaseLockedExecutionScope } from "@pi-cloud/runtime-core/session-lease-release";
import { transitionWorker, type WorkerState } from "@pi-cloud/domain";
import type { SandboxAssignmentInventory, SandboxRuntimeAssignment } from "@pi-cloud/protocol";
import { sql, type Kysely, type Transaction } from "kysely";
import { randomUUID } from "node:crypto";
import { requestLockedExecutionStreamSeal } from "@pi-cloud/runtime-core/execution-stream-seal";
import { createExecutionReference, parseExecutionReference } from "@pi-cloud/protocol";

const ACTIVE_SESSION_STATES = new Set(["running", "cancelling"]);
const ACTIVE_RUN_STATES = new Set(["running", "settling", "cancel_requested"]);

export type AssignmentReconcilerOptions = {
  database: Kysely<Database>;
  workerId: string;
  inventory: SandboxAssignmentInventory;
  clock?: () => Date;
};

export type AssignmentReconciliationResult = {
  inspectedRuntimes: number;
  terminatedRuntimes: number;
  orphanRuntimes: number;
  settledAssignments: number;
};

export type WorkerRetirementResult = AssignmentReconciliationResult & {
  workerState: "terminated";
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

export type DurableAssignment = {
  sessionId: string;
  executionReference: string;
  runId: string;
  turnId: string;
};

type Finalization = "settled" | "released" | "skipped";

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
 * Reconciles a worker only after its owning supervisor boot has been fenced
 * by the caller and can no longer create a runtime for an observed command.
 * Runtime absence is not a substitute for that supervisor-liveness decision.
 */
export class AssignmentReconciler {
  readonly #database: Kysely<Database>;
  readonly #workerId: string;
  readonly #inventory: SandboxAssignmentInventory;
  readonly #clock: () => Date;

  constructor(options: AssignmentReconcilerOptions) {
    if (options.workerId.trim().length === 0) {
      throw new TypeError("workerId must not be empty");
    }
    this.#database = options.database;
    this.#workerId = options.workerId;
    this.#inventory = options.inventory;
    this.#clock = options.clock ?? (() => new Date());
  }

  async retireWorker(): Promise<WorkerRetirementResult> {
    const now = validDate(this.#clock);
    try {
      await this.#beginRetirement(now);
      const runtimes = await this.#inventory.listAssignments();
      const worker = await this.#loadWorkerIdentity();
      this.#assertRuntimeScope(runtimes, worker);
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
      await this.#quarantineWorker(now).catch(() => undefined);
      throw this.#normalizeError(error);
    }
  }

  /**
   * Finalizes only durable state after the owner connection, Sandbox and lease
   * have already been fenced but the dead/partitioned process has no reachable
   * management endpoint. No runtime is adopted or assumed to be reusable.
   */
  async retireFencedWorker(): Promise<WorkerRetirementResult> {
    const now = validDate(this.#clock);
    try {
      await this.#beginRetirement(now);
      return await this.#finalizeRetirement(
        await this.#loadDurableAssignments(),
        emptyResult(0),
        now,
      );
    } catch (error: unknown) {
      await this.#quarantineWorker(now).catch(() => undefined);
      throw this.#normalizeError(error);
    }
  }

  async #loadWorkerIdentity(): Promise<{
    supervisorId: string;
    bootId: string;
    state: WorkerState;
  }> {
    const worker = await this.#database
      .selectFrom("workers")
      .select(["supervisor_id", "boot_id", "state"])
      .where("id", "=", this.#workerId)
      .executeTakeFirst();
    if (worker === undefined) {
      throw new AssignmentReconcilerError(
        "sandbox_unavailable",
        "Reconciliation worker was unavailable",
        false,
      );
    }
    return {
      supervisorId: worker.supervisor_id,
      bootId: worker.boot_id,
      state: worker.state,
    };
  }

  #assertRuntimeScope(
    runtimes: readonly SandboxRuntimeAssignment[],
    worker: { supervisorId: string; bootId: string },
  ): void {
    for (const runtime of runtimes) {
      if (
        runtime.sandboxId !== this.#workerId ||
        runtime.supervisorId !== worker.supervisorId ||
        runtime.bootId !== worker.bootId
      ) {
        throw new AssignmentReconcilerError(
          "runtime_identity_mismatch",
          "Observed runtime identity did not match its durable worker",
          false,
        );
      }
    }
  }

  async #loadDurableAssignments(): Promise<DurableAssignment[]> {
    const grants = await this.#database
      .selectFrom("active_execution_scopes")
      .select(["session_id", "lease_id", "run_id", "fencing_token", "turn_id"])
      .where("worker_id", "=", this.#workerId)
      .orderBy("valid_until", "asc")
      .execute();
    return grants.map((grant) => ({
      sessionId: grant.session_id,
      executionReference: createExecutionReference(
        grant.lease_id,
        grant.run_id,
        safeInteger(grant.fencing_token, "fencing token"),
      ),
      runId: grant.run_id,
      turnId: grant.turn_id,
    }));
  }

  async #finalizeRetirement(
    assignments: readonly DurableAssignment[],
    result: AssignmentReconciliationResult,
    now: Date,
  ): Promise<WorkerRetirementResult> {
    await this.#database.transaction().execute(async (transaction) => {
      for (const assignment of assignments) {
        const finalized = await reconcileExecutionScope(
          transaction,
          assignment,
          this.#workerId,
          false,
        );
        if (finalized === "settled" || finalized === "released") {
          result.settledAssignments += 1;
        }
      }
      const remaining = await transaction
        .selectFrom("active_execution_scopes")
        .select((expression) => expression.fn.countAll<string>().as("count"))
        .where("worker_id", "=", this.#workerId)
        .executeTakeFirstOrThrow();
      if (safeInteger(remaining.count, "remaining worker lease count") !== 0) {
        throw new AssignmentReconcilerError(
          "assignment_reconciliation_incomplete",
          "Sandbox retirement retained an assignment",
          true,
        );
      }
      const row = await transaction
        .selectFrom("workers")
        .select("state")
        .where("id", "=", this.#workerId)
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
        .updateTable("workers")
        .set({
          state: transitionWorker(row.state, "terminated"),
          updated_at: now,
          terminated_at: now,
        })
        .where("id", "=", this.#workerId)
        .where("state", "=", row.state)
        .executeTakeFirstOrThrow();
    });
    return { ...result, workerState: "terminated" };
  }

  async #beginRetirement(now: Date): Promise<void> {
    await this.#database.transaction().execute(async (transaction) => {
      const worker = await transaction
        .selectFrom("workers")
        .select(["state"])
        .where("id", "=", this.#workerId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (worker === undefined) {
        throw new AssignmentReconcilerError(
          "sandbox_unavailable",
          "Retirement worker was unavailable",
          false,
        );
      }
      if (
        worker.state === "terminated" ||
        worker.state === "draining" ||
        worker.state === "failed"
      ) {
        return;
      }
      const nextState =
        worker.state === "provisioning"
          ? transitionWorker(worker.state, "failed")
          : transitionWorker(worker.state, "draining");
      await transaction
        .updateTable("workers")
        .set({ state: nextState, updated_at: now })
        .where("id", "=", this.#workerId)
        .where("state", "=", worker.state)
        .executeTakeFirstOrThrow();
    });
  }

  async #quarantineWorker(now: Date): Promise<void> {
    await this.#database.transaction().execute(async (transaction) => {
      const worker = await transaction
        .selectFrom("workers")
        .select(["state"])
        .where("id", "=", this.#workerId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (worker === undefined || worker.state === "failed" || worker.state === "terminated") {
        return;
      }
      await transaction
        .updateTable("workers")
        .set({ state: transitionWorker(worker.state, "failed"), updated_at: now })
        .where("id", "=", this.#workerId)
        .where("state", "=", worker.state)
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

/** Shared final decision for expiry and already-authorized whole-Worker retirement. */
export async function reconcileExecutionScope(
  transaction: Transaction<Database>,
  candidate: DurableAssignment,
  workerId: string,
  requireExpired: boolean,
): Promise<Finalization> {
  const execution = parseExecutionReference(candidate.executionReference);
  const current = await transaction
    .selectFrom("runs as run")
    .innerJoin("sessions as session", "session.id", "run.session_id")
    .select([
      "run.id",
      "run.tenant_id",
      "run.session_id",
      "run.turn_id",
      "run.state as run_state",
      "run.output_seal_id",
      "run.lease_id",
      "run.fencing_token",
      "session.pi_session_id",
      "session.next_event_seq",
      "session.state as session_state",
    ])
    .where("run.turn_id", "=", candidate.turnId)
    .where("session.id", "=", candidate.sessionId)
    .where("run.id", "=", candidate.runId)
    .where("run.id", "=", execution.runId)
    .forNoKeyUpdate(["session", "run"])
    .$if(requireExpired, (q) => q.noWait())
    .executeTakeFirst();
  if (!current) return "skipped";
  await transaction
    .selectFrom("pi_sessions")
    .select("id")
    .where("tenant_id", "=", current.tenant_id)
    .where("id", "=", current.pi_session_id)
    .forUpdate()
    .$if(requireExpired, (q) => q.noWait())
    .executeTakeFirstOrThrow();
  const worker = await transaction
    .selectFrom("workers")
    .select("state")
    .where("id", "=", workerId)
    .forNoKeyUpdate()
    .$if(requireExpired, (q) => q.noWait())
    .executeTakeFirstOrThrow();
  if (requireExpired && worker.state !== "ready") return "skipped";
  await transaction
    .selectFrom("session_leases")
    .select("lease_id")
    .where("lease_id", "=", execution.leaseId)
    .forNoKeyUpdate()
    .$if(requireExpired, (q) => q.noWait())
    .execute();
  // Fresh PG time after every authority lock; an earlier committed renewal wins.
  const grant = await transaction
    .selectFrom("active_execution_scopes")
    .select(["lease_id", "run_id", "worker_id", "fencing_token"])
    .select(sql<Date>`clock_timestamp()`.as("decision_at"))
    .where("session_id", "=", candidate.sessionId)
    .where(sql<boolean>`(${!requireExpired} or valid_until <= clock_timestamp())`)
    .executeTakeFirst();
  if (
    !grant ||
    grant.lease_id !== execution.leaseId ||
    grant.run_id !== execution.runId ||
    grant.worker_id !== workerId ||
    safeInteger(grant.fencing_token, "final fencing token") !== execution.fencingToken
  )
    return "skipped";
  const now = grant.decision_at;
  if (!ACTIVE_RUN_STATES.has(current.run_state)) {
    if (ACTIVE_SESSION_STATES.has(current.session_state))
      throw new AssignmentReconcilerError(
        "assignment_invariant",
        "Active Session has no active execution during reconciliation",
        false,
      );
  } else {
    if (!ACTIVE_SESSION_STATES.has(current.session_state))
      throw new AssignmentReconcilerError(
        "assignment_invariant",
        "Execution and Session lifecycle are inconsistent",
        false,
      );
    await requestLockedExecutionStreamSeal(
      transaction,
      {
        tenantId: current.tenant_id,
        sessionId: candidate.sessionId,
        turnId: candidate.turnId,
        runId: candidate.runId,
        agentId: "root",
        recover: true,
        now,
        eventId: randomUUID(),
      },
      current,
    );
  }
  await releaseLockedExecutionScope(transaction, {
    tenantId: current.tenant_id,
    runId: execution.runId,
    leaseId: execution.leaseId,
    fencingToken: execution.fencingToken,
    now,
  });
  return ACTIVE_RUN_STATES.has(current.run_state) ? "settled" : "released";
}
