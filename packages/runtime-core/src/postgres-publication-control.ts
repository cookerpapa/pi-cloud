import type { Database } from "@pi-cloud/database";
import { isDeepStrictEqual } from "node:util";
import type { Kysely } from "kysely";
import type { AcceptedExecutionSealFact, AcceptedFactReceipt } from "./accepted-fact.ts";
import {
  PublicationIngressRejected,
  type PublicationOwnership,
} from "./session-publication-ingress.ts";
import type { KafkaSessionWriter } from "@pi-cloud/event-log";

/** Forced closure takes over the same Kafka identity only under a fresh PG
 * closure grant. Completed evidence never initializes another producer. */
export class PostgresPublicationControl {
  readonly #pending = new Map<string, Promise<AcceptedFactReceipt>>();
  readonly #writers = new Set<KafkaSessionWriter>();
  #closed = false;
  constructor(
    readonly options: {
      database: Kysely<Database>;
      current(owner: PublicationOwnership): boolean;
      beforeSeal(fact: AcceptedExecutionSealFact): Promise<void>;
      writer(
        owner: PublicationOwnership,
        fact: AcceptedExecutionSealFact,
        authorize: () => Promise<void>,
      ): KafkaSessionWriter;
    },
  ) {}

  async #state(fact: AcceptedExecutionSealFact): Promise<"open" | "closed"> {
    const row = await this.options.database
      .selectFrom("outbox as o")
      .innerJoin("session_leases as l", (join) =>
        join.on("l.lease_id", "=", fact.scope.writerId).onRef("l.tenant_id", "=", "o.tenant_id"),
      )
      .leftJoin("runs as r", (join) =>
        join.on("r.id", "=", fact.scope.runId).onRef("r.tenant_id", "=", "o.tenant_id"),
      )
      .select([
        "o.payload",
        "l.writer_sealed_at",
        "l.writer_failed_at",
        "r.output_seal_id",
        "r.lease_id",
      ])
      .where("o.tenant_id", "=", fact.scope.tenantId)
      .where("o.id", "=", fact.factId)
      .where("l.pi_session_id", "=", fact.scope.piSessionId)
      .where("l.fencing_token", "=", String(fact.scope.fencingToken))
      .executeTakeFirst();
    if (!row || !isDeepStrictEqual(row.payload, fact) || !fact.closesWriter)
      throw new PublicationIngressRejected("scope");
    if (row.writer_sealed_at !== null) return "closed";
    if (
      !row.writer_failed_at ||
      row.output_seal_id !== fact.factId ||
      row.lease_id !== fact.scope.writerId
    )
      throw new PublicationIngressRejected("scope");
    return "open";
  }
  seal(owner: PublicationOwnership, fact: AcceptedExecutionSealFact): Promise<AcceptedFactReceipt> {
    if (this.#closed || !this.options.current(owner))
      return Promise.reject(new PublicationIngressRejected("not_owner"));
    const key = JSON.stringify([fact.scope.tenantId, fact.factId]);
    const prior = this.#pending.get(key);
    if (prior) return prior;
    const promise = this.#seal(owner, fact).finally(() => {
      if (this.#pending.get(key) === promise) this.#pending.delete(key);
    });
    this.#pending.set(key, promise);
    return promise;
  }
  async #seal(
    owner: PublicationOwnership,
    fact: AcceptedExecutionSealFact,
  ): Promise<AcceptedFactReceipt> {
    const receipt = { factId: fact.factId, durable: true as const };
    if ((await this.#state(fact)) === "closed") return receipt;
    if (this.#closed || !this.options.current(owner))
      throw new PublicationIngressRejected("not_owner");
    await this.options.beforeSeal(fact);
    let closed = false;
    const writer = this.options.writer(owner, fact, async () => {
      if (this.#closed || !this.options.current(owner))
        throw new PublicationIngressRejected("not_owner");
      closed = (await this.#state(fact)) === "closed";
      if (closed) throw new PublicationIngressRejected("scope");
    });
    this.#writers.add(writer);
    try {
      await writer.start();
      return await writer.append({
        factId: fact.factId,
        sessionId: fact.scope.piSessionId,
        value: JSON.stringify(fact),
      });
    } catch (error) {
      if (closed) return receipt;
      throw error;
    } finally {
      await writer.close();
      this.#writers.delete(writer);
    }
  }
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#writers].map((writer) => writer.close()));
    await Promise.allSettled(this.#pending.values());
  }
}
