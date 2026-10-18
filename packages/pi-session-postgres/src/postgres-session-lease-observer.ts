import { NativeSessionError } from "./native-session-error.ts";
import type { Database } from "@pi-cloud/database";
import type { SupervisorHeartbeatMessage, SupervisorHeartbeatAckMessage } from "@pi-cloud/protocol";
import { sql, type Kysely, type Transaction } from "kysely";
import type { ActiveExecutionAuthority } from "./execution-authority.ts";

type Identity = SupervisorHeartbeatMessage["payload"]["families"][number];
type Observation = {
  identity: Identity;
  abort: AbortController;
  watching: boolean;
  revision: number;
  observedAt: number;
  deadline?: number;
};
const key = (identity: Identity) =>
  JSON.stringify([
    identity.tenantId,
    identity.piSessionId,
    identity.leaseId,
    identity.writerId,
    identity.fencingToken,
  ]);

/** One Worker-local read batch. PG remains authority; observations cannot renew it. */
export class PostgresSessionLeaseObserver {
  readonly #database: Kysely<Database>;
  readonly #now: () => number;
  readonly #interval: number;
  readonly #owners = new Map<string, Observation>();
  #pending: Promise<void> | undefined;
  #timer: NodeJS.Timeout | undefined;
  #deadlineTimer: NodeJS.Timeout | undefined;
  #closed = false;

  constructor(options: {
    database: Kysely<Database>;
    monotonicNow?: () => number;
    pollIntervalMs?: number;
  }) {
    this.#database = options.database;
    this.#now = options.monotonicNow ?? (() => performance.now());
    this.#interval = options.pollIntervalMs ?? 1_000;
    if (!Number.isSafeInteger(this.#interval) || this.#interval < 1)
      throw new TypeError("pollIntervalMs must be a positive safe integer");
  }

  open(identity: Identity): ActiveExecutionAuthority & { start(): void } {
    if (this.#closed) throw new Error("Session lease observer is closed");
    const id = key(identity);
    if (this.#owners.has(id)) throw new Error("Session lease already has an observer");
    const owner: Observation = {
      identity,
      abort: new AbortController(),
      watching: false,
      revision: 0,
      observedAt: -Infinity,
    };
    this.#owners.set(id, owner);
    return {
      signal: owner.abort.signal,
      assertCurrent: async (transaction?: Transaction<Database>) => {
        this.#expire(owner);
        owner.abort.signal.throwIfAborted();
        if (transaction) {
          await this.#untilAborted(this.#read([owner], transaction), owner.abort.signal);
          owner.abort.signal.throwIfAborted();
        }
        // Slow cold restore may outlive a cached deadline while PG renews it.
        // Refresh first; a stale cache alone is not evidence of revoked ownership.
        while (owner.deadline === undefined || owner.deadline <= this.#now()) {
          await this.#untilAborted(this.#refresh(), owner.abort.signal);
          owner.abort.signal.throwIfAborted();
        }
      },
      start: () => {
        owner.abort.signal.throwIfAborted();
        owner.watching = true;
        this.#expire(owner);
        owner.abort.signal.throwIfAborted();
        this.#scheduleDeadline();
        this.#schedule();
      },
      close: async () => {
        owner.abort.abort(
          new NativeSessionError("storage", "Pi Session execution authority closed"),
        );
        if (this.#owners.get(id) === owner) this.#owners.delete(id);
        this.#scheduleDeadline();
        if (![...this.#owners.values()].some((o) => o.watching && !o.abort.signal.aborted)) {
          clearTimeout(this.#timer);
          this.#timer = undefined;
        }
      },
    };
  }

  /** Only the committed, scope-checked direct-PG heartbeat is wired here. */
  observeRenewals(
    heartbeat: SupervisorHeartbeatMessage,
    acknowledgement: SupervisorHeartbeatAckMessage,
    requestedAt: number,
  ): void {
    if (
      acknowledgement.payload.acknowledgedMessageId !== heartbeat.messageId ||
      acknowledgement.payload.connectionId !== heartbeat.payload.connectionId
    )
      throw new Error("Lease observation acknowledgement identity changed");
    const reported = new Map(heartbeat.payload.families.map((r) => [r.leaseId, r.fencingToken]));
    const seen = new Set<string>();
    for (const value of [
      ...acknowledgement.payload.familyLeaseRenewals,
      ...acknowledgement.payload.familyLeaseDeferrals,
    ]) {
      if (seen.has(value.leaseId) || reported.get(value.leaseId) !== value.fencingToken)
        throw new Error("Lease observation acknowledgement scope changed");
      seen.add(value.leaseId);
    }
    const renewals = new Map(
      acknowledgement.payload.familyLeaseRenewals.map((r) => [r.leaseId, r]),
    );
    const deferred = new Set(acknowledgement.payload.familyLeaseDeferrals.map((r) => r.leaseId));
    for (const identity of heartbeat.payload.families) {
      const owner = this.#owners.get(key(identity));
      if (!owner || owner.abort.signal.aborted || requestedAt < owner.observedAt) continue;
      this.#expire(owner);
      if (deferred.has(identity.leaseId)) continue;
      const renewal = renewals.get(identity.leaseId);
      this.#observe(
        owner,
        requestedAt,
        renewal &&
          renewal.fencingToken === identity.fencingToken &&
          identity.writerId === identity.leaseId
          ? Date.parse(renewal.validUntil) - Date.parse(acknowledgement.sentAt)
          : undefined,
      );
    }
    this.#scheduleDeadline();
  }

  #observe(owner: Observation, requestedAt: number, remaining: number | undefined): void {
    this.#expire(owner);
    if (owner.abort.signal.aborted || this.#owners.get(key(owner.identity)) !== owner) return;
    owner.revision++;
    owner.observedAt = requestedAt;
    const deadline = remaining === undefined ? NaN : requestedAt + remaining;
    if (!Number.isFinite(deadline) || deadline <= this.#now()) {
      owner.abort.abort(
        new NativeSessionError(
          "storage",
          "Pi Session mutation was rejected by a stale ExecutionReference",
        ),
      );
    } else owner.deadline = deadline;
  }

  #expire(owner: Observation): void {
    if (owner.watching && owner.deadline !== undefined && owner.deadline <= this.#now())
      owner.abort.abort(
        new NativeSessionError("storage", "Pi Session confirmed lease lifetime expired"),
      );
  }

  #scheduleDeadline(): void {
    clearTimeout(this.#deadlineTimer);
    this.#deadlineTimer = undefined;
    if (this.#closed) return;
    let next = Infinity;
    for (const owner of this.#owners.values()) {
      this.#expire(owner);
      if (owner.watching && !owner.abort.signal.aborted && owner.deadline !== undefined)
        next = Math.min(next, owner.deadline);
    }
    if (Number.isFinite(next)) {
      this.#deadlineTimer = setTimeout(
        () => this.#scheduleDeadline(),
        Math.max(0, next - this.#now()),
      );
      this.#deadlineTimer.unref();
    }
  }

  #untilAborted(work: Promise<void>, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        signal.removeEventListener("abort", abort);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    });
  }

  #refresh(): Promise<void> {
    if (!this.#pending) {
      // Coalesce same-tick cold opens as well as periodic observations.
      const pending = Promise.resolve()
        .then(() =>
          this.#read(
            [...this.#owners.values()].filter((o) => !o.abort.signal.aborted),
            this.#database,
          ),
        )
        .finally(() => {
          if (this.#pending === pending) this.#pending = undefined;
        });
      this.#pending = pending;
    }
    return this.#pending;
  }

  async #read(owners: Observation[], database: Kysely<Database>): Promise<void> {
    if (!owners.length) return;
    const requestedAt = this.#now();
    const revisions = owners.map((owner) => owner.revision);
    try {
      const rows = await database
        .selectFrom("session_leases")
        .select([
          "tenant_id",
          "pi_session_id",
          "lease_id",
          "fencing_token",
          sql<string>`extract(epoch from (valid_until-clock_timestamp())) * 1000`.as(
            "remaining_ms",
          ),
        ])
        .where(
          "lease_id",
          "in",
          owners.map((o) => o.identity.leaseId),
        )
        .where("valid_until", ">", sql<Date>`clock_timestamp()`)
        .where("released_at", "is", null)
        .where("writer_failed_at", "is", null)
        .where("writer_sealed_at", "is", null)
        .execute();
      const leases = new Map(rows.map((row) => [row.lease_id, row]));
      for (const [index, owner] of owners.entries()) {
        // A newer committed renewal wins over an older in-flight read.
        if (owner.revision !== revisions[index]) continue;
        const { identity } = owner,
          row = leases.get(identity.leaseId);
        this.#observe(
          owner,
          requestedAt,
          row &&
            row.tenant_id === identity.tenantId &&
            row.pi_session_id === identity.piSessionId &&
            identity.writerId === identity.leaseId &&
            Number(row.fencing_token) === identity.fencingToken
            ? Number(row.remaining_ms)
            : undefined,
        );
      }
    } catch (error) {
      for (const [index, owner] of owners.entries())
        if (owner.revision === revisions[index]) owner.abort.abort(error);
      throw error;
    } finally {
      this.#scheduleDeadline();
    }
  }

  #schedule(): void {
    const active = [...this.#owners.values()].filter((o) => o.watching && !o.abort.signal.aborted);
    if (this.#closed || this.#timer || !active.length) return;
    const delay = Math.max(
      0,
      Math.min(this.#interval, ...active.map((o) => o.observedAt + this.#interval - this.#now())),
    );
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const due = [...this.#owners.values()].some(
        (o) =>
          o.watching && !o.abort.signal.aborted && this.#now() - o.observedAt >= this.#interval,
      );
      void (due ? this.#refresh() : Promise.resolve())
        .catch(() => {})
        .finally(() => this.#schedule());
    }, delay);
    this.#timer.unref();
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearTimeout(this.#timer);
    clearTimeout(this.#deadlineTimer);
    this.#timer = undefined;
    for (const owner of this.#owners.values())
      owner.abort.abort(new NativeSessionError("storage", "Session lease observer closed"));
    this.#owners.clear();
    // Read results check owner identity/abort before adoption. The bounded lease
    // pool owns socket cleanup; closing local authority must never wait for PG.
  }
}
