import type { Database } from "@pi-cloud/database";
import { parseExecutionLease } from "@pi-cloud/protocol";
import { SessionError } from "@earendil-works/pi-agent-core";
import type { Kysely, Transaction } from "kysely";
import type { ActiveExecutionAuthority } from "./execution-authority.ts";

export type PostgresRunExecutionAuthorityOptions = {
  database: Kysely<Database>;
  tenantId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  executionLease: string;
  clock?: () => Date;
  pollIntervalMs?: number;
};

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

/** Cloud liveness watch. Step checks use only the observed lease deadline;
 * Ordered Projector closure and Tool Broker guard the actual effects. */
export class PostgresRunExecutionAuthority implements ActiveExecutionAuthority {
  readonly #database: Kysely<Database>;
  readonly #tenantId: string;
  readonly #sessionId: string;
  readonly #runId: string;
  readonly #turnId: string;
  readonly #executionLease: ReturnType<typeof parseExecutionLease>;
  readonly #clock: () => Date;
  readonly #pollIntervalMs: number;
  readonly #abort = new AbortController();
  #watch: Promise<void> | undefined;
  #closed = false;
  #validUntil: Date | undefined;

  constructor(options: PostgresRunExecutionAuthorityOptions) {
    this.#database = options.database;
    this.#tenantId = options.tenantId;
    this.#sessionId = options.sessionId;
    this.#runId = options.runId;
    this.#turnId = options.turnId;
    this.#executionLease = parseExecutionLease(options.executionLease);
    this.#clock = options.clock ?? (() => new Date());
    this.#pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 1_000, "pollIntervalMs");
  }

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  start(): void {
    if (this.#closed) throw new Error("PostgreSQL Run execution authority is closed");
    this.#watch ??= this.#watchCurrent();
  }

  async assertCurrent(database?: Transaction<Database>): Promise<void> {
    if (this.#closed || this.#abort.signal.aborted) {
      throw new SessionError("storage", "Pi Session execution authority is no longer active");
    }
    if (database || this.#validUntil === undefined) return this.#verify(database ?? this.#database);
    if (this.#validUntil <= this.#clock()) {
      const error = new SessionError("storage", "Observed execution lease expired");
      this.#abort.abort(error);
      throw error;
    }
  }

  async #verify(authority: Kysely<Database>) {
    const row = await authority
      .selectFrom("session_leases")
      .innerJoin("run_attempts as attempt", "attempt.id", "session_leases.attempt_id")
      .innerJoin("run_attempts as writer", "writer.id", "attempt.native_writer_id")
      .select("session_leases.valid_until")
      .where("session_leases.lease_id", "=", this.#executionLease.leaseId)
      .where("session_leases.attempt_id", "=", this.#executionLease.attemptId)
      .where("session_leases.fencing_token", "=", String(this.#executionLease.fencingToken))
      .where("session_leases.tenant_id", "=", this.#tenantId)
      .where("session_leases.session_id", "=", this.#sessionId)
      .where("session_leases.run_id", "=", this.#runId)
      .where("session_leases.turn_id", "=", this.#turnId)
      .where("valid_until", ">", this.#clock())
      .where("writer.native_writer_failed_at", "is", null)
      .where("writer.native_writer_sealed_at", "is", null)
      .executeTakeFirst();
    if (row === undefined) {
      const error = new SessionError(
        "storage",
        "Pi Session mutation was rejected by a stale ExecutionLease",
      );
      this.#abort.abort(error);
      throw error;
    }
    this.#validUntil = row.valid_until;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort(new Error("PostgreSQL Run execution authority closed"));
    await this.#watch;
  }

  async #watchCurrent(): Promise<void> {
    while (!this.#closed && !this.#abort.signal.aborted) {
      await new Promise<void>((resolvePromise) => {
        let settled = false;
        const settle = (): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.#abort.signal.removeEventListener("abort", settle);
          resolvePromise();
        };
        const timer = setTimeout(settle, this.#pollIntervalMs);
        timer.unref();
        this.#abort.signal.addEventListener("abort", settle, { once: true });
      });
      if (this.#closed || this.#abort.signal.aborted) return;
      try {
        await this.#verify(this.#database);
      } catch (error) {
        this.#abort.abort(error);
        return;
      }
    }
  }
}
