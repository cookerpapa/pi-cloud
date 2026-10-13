import { KafkaSessionWriter, ACCEPTED_FACT_TOPIC } from "@pi-cloud/event-log";
import type { Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import { MAX_EXECUTION_FACT_BYTES, PublicationNotSentError } from "@pi-cloud/protocol";
import { isDeepStrictEqual } from "node:util";
import type {
  AcceptedFact,
  AcceptedFactBus,
  AcceptedFactScope,
  ExecutionPublication,
} from "./accepted-fact.ts";
import { kafkaProducerLane, parseAcceptedFact } from "./kafka-accepted-fact.ts";
import { ExecutionLogTopic } from "./execution-log-topic.ts";
import { toolCommandsForFact, controlToolsForFact } from "./tool-invocation-fact.ts";

export function assertSessionPublication(
  publication: ExecutionPublication,
  fact: AcceptedFact,
): void {
  const root = publication.scope;
  const check = (scope: AcceptedFactScope) => {
    for (const key of ["tenantId", "piSessionId", "runId", "writerId", "fencingToken"] as const)
      if (scope[key] !== root[key])
        throw new PublicationNotSentError("Record belongs to another Session writer");
  };
  check(fact.scope);
  if (fact.kind === "execution_seal" || fact.kind === "tool_command")
    throw new PublicationNotSentError("Workers publish only native intents and work records");
  parseAcceptedFact(fact);
  if (fact.kind === "durable_commit") {
    for (const tool of [...toolCommandsForFact(fact), ...controlToolsForFact(fact)])
      check(tool.scope);
    for (const cancel of fact.cancellations) check(cancel.scope);
    for (const display of fact.display) check(display.scope);
  }
}

/** Root authority is checked at producer initialization. Every Conversation
 * then uses the same Session producer and local grant without per-record SQL. */
export class DirectSessionKafkaBus implements AcceptedFactBus {
  readonly #writers = new Map<
    string,
    { publication: ExecutionPublication; writer: KafkaSessionWriter; retired: boolean }
  >();
  readonly #opening = new Map<string, Promise<void>>();
  readonly #topic: ExecutionLogTopic;
  #starting: Promise<void> | undefined;
  #closed = false;
  constructor(
    readonly options: {
      database: Kysely<Database>;
      brokers: readonly string[];
      clientId: string;
      partitions: number;
      replicas: number;
      topic?: string;
    },
  ) {
    this.#topic = new ExecutionLogTopic({ ...options, manageTopic: false });
  }
  #key(scope: Pick<AcceptedFactScope, "tenantId" | "piSessionId">): string {
    return JSON.stringify([scope.tenantId, scope.piSessionId]);
  }
  async #authorize(publication: ExecutionPublication): Promise<void> {
    const scope = publication.scope;
    const row = await this.options.database
      .selectFrom("runs as r")
      .innerJoin("session_leases as l", "l.lease_id", "r.lease_id")
      .select("r.output_publication")
      .where("r.tenant_id", "=", scope.tenantId)
      .where("r.id", "=", scope.runId)
      .where("l.tenant_id", "=", scope.tenantId)
      .where("l.pi_session_id", "=", scope.piSessionId)
      .where("l.lease_id", "=", scope.writerId)
      .where("l.fencing_token", "=", String(scope.fencingToken))
      .where("l.released_at", "is", null)
      .where("l.writer_failed_at", "is", null)
      .where("l.writer_sealed_at", "is", null)
      .where("l.valid_until", ">", sql<Date>`clock_timestamp()`)
      .where("r.output_seal_id", "is", null)
      .where("r.state", "in", ["running", "settling", "cancel_requested"])
      .executeTakeFirst();
    if (!row || !isDeepStrictEqual(row.output_publication, publication))
      throw new PublicationNotSentError("Session producer grant is no longer current");
  }
  open(publication: ExecutionPublication, signal?: AbortSignal): Promise<void> {
    const key = this.#key(publication.scope);
    if (this.#opening.has(key))
      return Promise.reject(new PublicationNotSentError("Session producer is already opening"));
    const pending = this.#open(publication, signal).finally(() => {
      if (this.#opening.get(key) === pending) this.#opening.delete(key);
    });
    this.#opening.set(key, pending);
    return pending;
  }
  async #open(publication: ExecutionPublication, signal?: AbortSignal): Promise<void> {
    if (this.#closed) throw new PublicationNotSentError("Session publication is closed");
    signal?.throwIfAborted();
    const key = this.#key(publication.scope),
      prior = this.#writers.get(key);
    if (prior)
      throw new PublicationNotSentError(
        "Retire the existing Session writer before opening another one",
      );
    const entry = {
      publication: structuredClone(publication),
      writer: undefined as unknown as KafkaSessionWriter,
      retired: false,
    };
    entry.writer = new KafkaSessionWriter({
      brokers: this.options.brokers,
      clientId: this.options.clientId,
      topic: this.options.topic ?? ACCEPTED_FACT_TOPIC,
      partition: kafkaProducerLane(publication.scope.piSessionId, this.options.partitions),
      tenantId: publication.scope.tenantId,
      sessionId: publication.scope.piSessionId,
      current: () => !this.#closed && !entry.retired && !signal?.aborted,
      authorize: async (phase) => {
        signal?.throwIfAborted();
        await this.#authorize(publication);
        if (phase === "after_init") {
          const current = this.#writers.get(key);
          if (current && current !== prior)
            throw new PublicationNotSentError("Session initialization was replaced locally");
          if (this.#closed || signal?.aborted)
            throw new PublicationNotSentError("Session initialization ended locally");
          this.#writers.set(key, entry);
        }
      },
    });
    try {
      await entry.writer.start();
    } catch (error) {
      entry.retired = true;
      await entry.writer.close();
      if (this.#writers.get(key) === entry) this.#writers.delete(key);
      throw error;
    }
  }
  async append(fact: AcceptedFact) {
    const entry = this.#writers.get(this.#key(fact.scope));
    const scope = entry?.publication.scope;
    if (
      !entry ||
      entry.retired ||
      !scope ||
      scope.runId !== fact.scope.runId ||
      scope.writerId !== fact.scope.writerId ||
      scope.fencingToken !== fact.scope.fencingToken ||
      fact.kind === "execution_seal"
    )
      throw new PublicationNotSentError("Session writer is unavailable for this record");
    const value = JSON.stringify(fact);
    if (Buffer.byteLength(value) > MAX_EXECUTION_FACT_BYTES)
      throw new PublicationNotSentError("Session record exceeds its transport budget");
    try {
      assertSessionPublication(entry.publication, fact);
    } catch (cause) {
      throw new PublicationNotSentError("Session record is invalid", { cause });
    }
    return entry.writer.append({ factId: fact.factId, sessionId: fact.scope.piSessionId, value });
  }
  async forget(scope: AcceptedFactScope): Promise<void> {
    const key = this.#key(scope),
      entry = this.#writers.get(key);
    if (
      !entry ||
      entry.publication.scope.writerId !== scope.writerId ||
      entry.publication.scope.runId !== scope.runId
    )
      return;
    entry.retired = true;
    this.#writers.delete(key);
    await entry.writer.close();
  }
  publicationFailure(scope: AcceptedFactScope): unknown {
    const entry = this.#writers.get(this.#key(scope));
    return entry?.publication.scope.writerId === scope.writerId ? entry.writer.failure : undefined;
  }
  async publicationAvailability() {
    await this.checkHealth();
    return {
      partitionCount: this.options.partitions,
      partitions: await this.#topic.availablePartitions(),
    };
  }
  async checkHealth(): Promise<void> {
    if (this.#closed) throw new Error("Session publication is closed");
    this.#starting ??= this.#topic.start().catch((error) => {
      this.#starting = undefined;
      throw error;
    });
    await this.#starting;
    await this.#topic.checkHealth();
    if (this.#closed) throw new Error("Session publication is closed");
  }
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled(this.#opening.values());
    const entries = [...this.#writers.values()];
    this.#writers.clear();
    for (const entry of entries) entry.retired = true;
    await Promise.allSettled(entries.map((entry) => entry.writer.close()));
    await this.#starting?.catch(() => {});
    await this.#topic.close();
  }
}
