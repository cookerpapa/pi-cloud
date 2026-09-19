import type { Database } from "@pi-cloud/database";
import { SessionError } from "@earendil-works/pi-agent-core";
import { sql, type Kysely, type Transaction } from "kysely";
import type { ActiveExecutionAuthority } from "./execution-authority.ts";

export type PostgresSessionExecutionAuthorityOptions = {
  database: Kysely<Database>;
  tenantId: string;
  piSessionId: string;
  leaseId: string;
  writerId: string;
  fencingToken: number;
  monotonicNow?: () => number;
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
export class PostgresSessionExecutionAuthority implements ActiveExecutionAuthority {
  readonly #database: Kysely<Database>;
  readonly #tenantId: string;
  readonly #identity: PostgresSessionExecutionAuthorityOptions;
  readonly #monotonicNow: () => number;
  readonly #pollIntervalMs: number;
  readonly #abort = new AbortController();
  #watch: Promise<void> | undefined;
  #closed = false;
  #deadline: number | undefined;

  constructor(options: PostgresSessionExecutionAuthorityOptions) {
    this.#database = options.database;
    this.#tenantId = options.tenantId;
    this.#identity = options;
    this.#monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.#pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 1_000, "pollIntervalMs");
  }

  get signal(): AbortSignal {
    return this.#abort.signal;
  }

  start(): void {
    if (this.#closed) throw new Error("PostgreSQL Session execution authority is closed");
    this.#watch ??= this.#watchCurrent();
  }

  async assertCurrent(database?: Transaction<Database>): Promise<void> {
    if (this.#closed || this.#abort.signal.aborted) {
      throw new SessionError("storage", "Pi Session execution authority is no longer active");
    }
    // Cold restore can outlive the first observation while the Worker heartbeat
    // keeps renewing the real lease. An expired cache is not proof of owner loss.
    if (database || this.#deadline === undefined || this.#deadline <= this.#monotonicNow())
      return this.#verify(database ?? this.#database);
  }

  async #verify(authority: Kysely<Database>) {
    const requestedAt = this.#monotonicNow();
    const row = await authority
      .selectFrom("session_leases")
      .select(
        sql<string>`extract(epoch from (session_leases.valid_until-clock_timestamp())) * 1000`.as(
          "remaining_ms",
        ),
      )
      .where("session_leases.lease_id", "=", this.#identity.leaseId)
      .where("session_leases.lease_id", "=", this.#identity.writerId)
      .where("session_leases.fencing_token", "=", String(this.#identity.fencingToken))
      .where("session_leases.tenant_id", "=", this.#tenantId)
      .where("session_leases.pi_session_id", "=", this.#identity.piSessionId)
      .where("valid_until", ">", sql<Date>`clock_timestamp()`)
      .where("released_at", "is", null)
      .where("writer_failed_at", "is", null)
      .where("writer_sealed_at", "is", null)
      .executeTakeFirst();
    const deadline = row === undefined ? undefined : requestedAt + Number(row.remaining_ms);
    if (deadline === undefined || deadline <= this.#monotonicNow()) {
      const error = new SessionError(
        "storage",
        "Pi Session mutation was rejected by a stale ExecutionReference",
      );
      this.#abort.abort(error);
      throw error;
    }
    this.#deadline = deadline;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#abort.abort(new Error("PostgreSQL Session execution authority closed"));
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
