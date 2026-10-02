import { PostgresNotificationWake, type Database } from "@pi-cloud/database";
import { operationalLog } from "@pi-cloud/observability";
import {
  SESSION_TERMINAL_EVENT_OUTBOX_TOPIC,
  SESSION_CONTROL_OUTBOX_TOPIC,
  SESSION_CONTROL_NOTIFICATION_CHANNEL,
  type SessionControlChange,
} from "@pi-cloud/protocol";
import { setTimeout as delay } from "node:timers/promises";
import { sql, type Kysely } from "kysely";
import type { AcceptedExecutionSealFact, AcceptedFactReceipt } from "./accepted-fact.ts";
import { parseSessionLogFact } from "./kafka-accepted-fact.ts";

type ClaimedControl = { id: string; payload: Record<string, unknown>; attempts: number };
type ControlOutboxBus = {
  append(fact: AcceptedExecutionSealFact | SessionControlChange): Promise<AcceptedFactReceipt>;
  checkHealth(): Promise<void>;
};

export class SessionOutboxRelay {
  readonly #database: Kysely<Database>;
  readonly #bus: ControlOutboxBus;
  readonly #pollIntervalMs: number;
  readonly #claimLeaseMs: number;
  readonly #concurrency: number;
  readonly #wake: PostgresNotificationWake;
  readonly #active = new Map<string, Promise<void>>();
  #abort: AbortController | undefined;
  #task: Promise<void> | undefined;
  #failure: unknown;
  #retryAt = Infinity;
  #cleanupTimer: NodeJS.Timeout | undefined;
  #cleanup: Promise<void> | undefined;
  #cleanupDue = 0;

  constructor(options: {
    database: Kysely<Database>;
    notificationConnectionString: string;
    bus: ControlOutboxBus;
    pollIntervalMs?: number;
    claimLeaseMs?: number;
    concurrency?: number;
  }) {
    this.#database = options.database;
    this.#bus = options.bus;
    this.#wake = new PostgresNotificationWake(
      options.notificationConnectionString,
      SESSION_CONTROL_NOTIFICATION_CHANNEL,
    );
    this.#pollIntervalMs = options.pollIntervalMs ?? 1000;
    this.#claimLeaseMs = options.claimLeaseMs ?? 30_000;
    this.#concurrency = options.concurrency ?? 16;
    for (const value of [this.#pollIntervalMs, this.#claimLeaseMs, this.#concurrency]) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new TypeError("Session Outbox relay limits must be positive integers");
    }
  }

  start(): void {
    if (this.#task !== undefined) throw new Error("Session Outbox relay is already started");
    this.#abort = new AbortController();
    this.#task = this.#run(this.#abort.signal);
    this.#cleanupTimer = setInterval(() => this.#clean(), 1000);
    this.#cleanupTimer.unref();
  }

  checkHealth(): void {
    if (this.#task === undefined || this.#failure !== undefined) {
      throw new Error("Session Outbox relay is unhealthy");
    }
  }

  async close(): Promise<void> {
    this.#abort?.abort();
    clearInterval(this.#cleanupTimer);
    try {
      await this.#task;
      await Promise.allSettled(this.#active.values());
      await this.#cleanup;
    } finally {
      await this.#wake.close();
    }
    this.#task = undefined;
  }

  async dispatchOne(): Promise<boolean> {
    const [row] = await this.#claim(1);
    if (!row) return false;
    try {
      await this.#publish(row);
    } catch (error) {
      throw new AggregateError([error], "Session control publication failed");
    }
    return true;
  }

  /** Keep current view versions and unsettled publication; obsolete references
   * are not a second control history. Native seals retain their existing rules. */
  async prunePublishedControls(): Promise<number> {
    const deleted = await sql<{ id: string }>`delete from outbox where id in (
      select old.id from outbox old
      where old.aggregate_type='session_control_change' and old.published_at < clock_timestamp()-interval '5 minutes'
        and (
          old.payload->>'entity'<>'input_queue'
          or exists(select 1 from outbox newer where newer.aggregate_type='session_control_change'
            and newer.tenant_id=old.tenant_id and newer.aggregate_id=old.aggregate_id
            and newer.payload->>'entity'=old.payload->>'entity'
            and newer.payload->>'runId' is not distinct from old.payload->>'runId'
            and (newer.payload->>'version')::bigint > (old.payload->>'version')::bigint
            and newer.published_at is not null)
          or (old.payload->>'entity'='input_queue' and not exists(
            select 1 from sessions s where s.tenant_id=old.tenant_id and s.id=old.aggregate_id))
        ) order by old.created_at,old.id limit 512
    ) returning id`.execute(this.#database);
    return deleted.rows.length;
  }

  async #claim(limit: number): Promise<readonly ClaimedControl[]> {
    // available_at is the retry/claim deadline; attempts is a CAS token.
    // No transaction or database connection spans Kafka delivery.
    // Keep terminal Session heads and control-entity heads ordered. Synchronous
    // lifecycle publication uses the same idempotent records and ingress.
    const claimed = await sql<ClaimedControl>`
      with selected as (
        select candidate.id from outbox candidate
         where candidate.topic in (${SESSION_TERMINAL_EVENT_OUTBOX_TOPIC},${SESSION_CONTROL_OUTBOX_TOPIC})
           and candidate.aggregate_type in ('session_terminal_event','session_control_change')
           and candidate.published_at is null and candidate.available_at <= now()
           and not(candidate.id=any(${[...this.#active.keys()]}::uuid[]))
           and not exists (
             select 1 from outbox predecessor
              where predecessor.topic = candidate.topic
                and predecessor.aggregate_type = candidate.aggregate_type
                and predecessor.tenant_id = candidate.tenant_id
                and (case when candidate.aggregate_type='session_terminal_event'
                  then predecessor.payload #>> '{scope,sessionId}' = candidate.payload #>> '{scope,sessionId}'
                  else predecessor.aggregate_id=candidate.aggregate_id end)
                and predecessor.published_at is null
                and (predecessor.created_at, predecessor.id) < (candidate.created_at, candidate.id)
           )
         order by candidate.created_at, candidate.id
         limit ${limit} for update of candidate skip locked
      )
      update outbox as claimed
         set attempts = claimed.attempts + 1,
             available_at = now() + ${this.#claimLeaseMs} * interval '1 millisecond'
        from selected where claimed.id = selected.id
      returning claimed.id, claimed.payload, claimed.attempts
    `.execute(this.#database);
    return claimed.rows;
  }

  async #publish(row: ClaimedControl): Promise<void> {
    try {
      const fact = parseSessionLogFact(JSON.stringify(row.payload));
      if (fact.kind !== "execution_seal" && fact.kind !== "control_change")
        throw new Error("Session Outbox contains a non-control Fact");
      const receipt = await this.#bus.append(fact);
      if (!receipt.durable || receipt.factId !== fact.factId)
        throw new Error("Session control receipt did not match its Fact");
      await this.#database
        .updateTable("outbox")
        .set({ published_at: sql<Date>`clock_timestamp()`, last_error: null })
        .where("id", "=", row.id)
        .where("attempts", "=", row.attempts)
        .where("published_at", "is", null)
        .executeTakeFirst();
      // A newer claimant may already have delivered the same immutable Fact.
      // A stale sender must not overwrite the newer claim.
    } catch (error: unknown) {
      const retryMs = Math.min(30_000, 100 * 2 ** Math.min(8, row.attempts - 1));
      await this.#database
        .updateTable("outbox")
        .set({
          available_at: sql<Date>`clock_timestamp() + ${retryMs} * interval '1 millisecond'`,
          last_error: "session_control_publish_failed",
        })
        .where("id", "=", row.id)
        .where("attempts", "=", row.attempts)
        .where("published_at", "is", null)
        .executeTakeFirst();
      this.#retryAt = Math.min(this.#retryAt, performance.now() + retryMs);
      throw error;
    }
  }

  #clean(): void {
    if (this.#abort?.signal.aborted || this.#cleanup || performance.now() < this.#cleanupDue)
      return;
    this.#cleanup = (async () => {
      const started = performance.now();
      let more = false;
      for (let batch = 0; batch < 8 && !this.#abort?.signal.aborted; batch++) {
        more = (await this.prunePublishedControls()) === 512;
        if (!more || performance.now() - started >= 1000) break;
      }
      this.#cleanupDue = performance.now() + (more ? 1000 : 60000);
    })()
      .catch(() => {
        this.#cleanupDue = performance.now() + 30000;
        operationalLog({
          service: "pi-cloud-control-plane",
          level: "warn",
          event: "control_outbox.cleanup_failed",
        });
      })
      .finally(() => {
        this.#cleanup = undefined;
      });
  }

  async #run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      this.#wake.refresh();
      const generation = this.#wake.generation;
      let failed = false;
      if (this.#active.size < this.#concurrency) {
        if (this.#retryAt <= performance.now()) this.#retryAt = Infinity;
        try {
          const rows = await this.#claim(this.#concurrency - this.#active.size);
          this.#failure = undefined;
          for (const row of rows) {
            const task = this.#publish(row)
              .catch((error) => {
                this.#failure = error;
              })
              .finally(() => {
                this.#active.delete(row.id);
                this.#wake.notify();
              });
            this.#active.set(row.id, task);
          }
          if (rows.length) continue;
        } catch (error) {
          this.#failure = error;
          failed = true;
        }
      }
      const waitMs =
        this.#active.size >= this.#concurrency
          ? this.#pollIntervalMs
          : Math.max(1, Math.min(this.#pollIntervalMs, this.#retryAt - performance.now()));
      try {
        // A failed claim backs off independently of frequent notification hints.
        if (failed)
          await delay(Math.max(100, this.#pollIntervalMs), undefined, { signal, ref: false });
        else await this.#wake.wait(generation, waitMs, signal);
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
  }
}
