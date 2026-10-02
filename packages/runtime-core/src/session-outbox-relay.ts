import { PostgresNotificationWake, type Database } from "@pi-cloud/database";
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
  readonly #batchSize: number;
  readonly #wake: PostgresNotificationWake;
  #abort: AbortController | undefined;
  #task: Promise<void> | undefined;
  #failure: unknown;

  constructor(options: {
    database: Kysely<Database>;
    notificationConnectionString: string;
    bus: ControlOutboxBus;
    pollIntervalMs?: number;
    claimLeaseMs?: number;
    batchSize?: number;
  }) {
    this.#database = options.database;
    this.#bus = options.bus;
    this.#wake = new PostgresNotificationWake(
      options.notificationConnectionString,
      SESSION_CONTROL_NOTIFICATION_CHANNEL,
    );
    this.#pollIntervalMs = options.pollIntervalMs ?? 50;
    this.#claimLeaseMs = options.claimLeaseMs ?? 30_000;
    this.#batchSize = options.batchSize ?? 16;
    for (const value of [this.#pollIntervalMs, this.#claimLeaseMs, this.#batchSize]) {
      if (!Number.isSafeInteger(value) || value < 1)
        throw new TypeError("Session Outbox relay limits must be positive integers");
    }
  }

  start(): void {
    if (this.#task !== undefined) throw new Error("Session Outbox relay is already started");
    this.#abort = new AbortController();
    this.#task = this.#run(this.#abort.signal);
  }

  checkHealth(): void {
    if (this.#task === undefined || this.#failure !== undefined) {
      throw new Error("Session Outbox relay is unhealthy");
    }
  }

  async close(): Promise<void> {
    this.#abort?.abort();
    try {
      await this.#task;
    } finally {
      await this.#wake.close();
    }
    this.#task = undefined;
  }

  async dispatchOne(): Promise<boolean> {
    return (await this.#dispatch(1)) > 0;
  }

  async #dispatch(limit: number): Promise<number> {
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
    const results = await Promise.allSettled(claimed.rows.map((row) => this.#publish(row)));
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length)
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        "Session control publication failed",
      );
    return claimed.rows.length;
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
        .set({ published_at: new Date(), last_error: null })
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
          available_at: new Date(Date.now() + retryMs),
          last_error: "session_control_publish_failed",
        })
        .where("id", "=", row.id)
        .where("attempts", "=", row.attempts)
        .where("published_at", "is", null)
        .executeTakeFirst();
      throw error;
    }
  }

  async #run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      this.#wake.refresh();
      const generation = this.#wake.generation;
      let waitMs = this.#pollIntervalMs;
      let failed = false;
      try {
        const count = await this.#dispatch(this.#batchSize);
        this.#failure = undefined;
        if (count > 0) {
          continue;
        }
      } catch (error: unknown) {
        this.#failure = error;
        failed = true;
        waitMs = Math.max(waitMs, 100);
      }
      try {
        // Hints must not bypass the existing backoff after a failed claim/send.
        if (failed) await delay(waitMs, undefined, { signal, ref: false });
        else await this.#wake.wait(generation, waitMs, signal);
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
  }
}
