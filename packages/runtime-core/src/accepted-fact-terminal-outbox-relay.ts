import type { Database } from "@pi-cloud/database";
import { SESSION_TERMINAL_EVENT_OUTBOX_TOPIC } from "@pi-cloud/protocol";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { AcceptedFactBus } from "./accepted-fact.ts";
import { parseKafkaAcceptedFact } from "./kafka-accepted-fact.ts";

export class AcceptedFactTerminalOutboxRelay {
  readonly #database: Kysely<Database>;
  readonly #bus: AcceptedFactBus;
  readonly #pollIntervalMs: number;
  #abort: AbortController | undefined;
  #task: Promise<void> | undefined;
  #failure: unknown;

  constructor(options: {
    database: Kysely<Database>;
    bus: AcceptedFactBus;
    pollIntervalMs?: number;
  }) {
    this.#database = options.database;
    this.#bus = options.bus;
    this.#pollIntervalMs = options.pollIntervalMs ?? 50;
  }

  start(): void {
    this.#abort = new AbortController();
    this.#task = this.#run(this.#abort.signal).catch((error: unknown) => {
      this.#failure = error;
    });
  }

  checkHealth(): void {
    if (this.#task === undefined || this.#failure !== undefined) {
      throw new Error("AcceptedFact terminal outbox relay is unhealthy");
    }
  }

  async close(): Promise<void> {
    this.#abort?.abort();
    await this.#task;
    this.#task = undefined;
  }

  async dispatchOne(): Promise<boolean> {
    return this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom("outbox")
        .select(["id", "payload"])
        .where("topic", "=", SESSION_TERMINAL_EVENT_OUTBOX_TOPIC)
        .where("published_at", "is", null)
        .where("available_at", "<=", new Date())
        .orderBy("created_at", "asc")
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (row === undefined) return false;
      const fact = parseKafkaAcceptedFact(JSON.stringify(row.payload));
      if (fact.kind !== "terminal_event") {
        throw new Error("Terminal outbox payload is not an Accepted terminal Fact");
      }
      await this.#bus.append(fact);
      const updated = await transaction
        .updateTable("outbox")
        .set({
          attempts: sql<number>`${sql.ref("attempts")} + 1`,
          published_at: new Date(),
          last_error: null,
        })
        .where("id", "=", row.id)
        .where("published_at", "is", null)
        .executeTakeFirst();
      if (updated.numUpdatedRows !== 1n) throw new Error("Terminal event outbox claim was lost");
      return true;
    });
  }

  async #run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      if (await this.dispatchOne()) continue;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.#pollIntervalMs);
        timer.unref();
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  }
}
