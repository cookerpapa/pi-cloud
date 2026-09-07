import type { Database } from "@pi-cloud/database";
import { parsePiCloudEvent, type PiCloudEvent } from "@pi-cloud/protocol";
import { sql, type Kysely } from "kysely";
import type { AcceptedExecutionSealFact, AcceptedFact } from "./accepted-fact.ts";
import { AcceptedFactProjectionPendingError } from "./accepted-fact.ts";
import type { KafkaAcceptedFactRecord } from "./kafka-accepted-fact-consumer.ts";
import { appendInterruptedAssistantPrefix } from "./canonical-pi-conversation.ts";
import { projectConversationTurnTranscript } from "./conversation-turn-projection.ts";
import { PostgresPiSessionMutationProjector } from "./postgres-pi-session-mutation-projector.ts";

export function factEvents(fact: AcceptedFact): readonly PiCloudEvent[] {
  return fact.kind === "agent_event"
    ? [fact.event]
    : fact.kind === "pi_session_mutation"
      ? fact.events
      : [];
}

/** Durable closure is checked once per execution, not once per token. Closed
 * tombstones can be evicted: their authority is the RunAttempt row, not RAM. */
export class ExecutionStreamBoundary {
  readonly #database: Kysely<Database>;
  readonly #open = new Set<string>();
  readonly #closed = new Set<string>();
  readonly #retentionMs: number;

  constructor(database: Kysely<Database>, retentionMs = 24 * 60 * 60_000) {
    this.#database = database;
    this.#retentionMs = retentionMs;
  }

  reset(): void {
    this.#open.clear();
    this.#closed.clear();
  }

  close(attemptId: string): void {
    this.#open.delete(attemptId);
    this.#closed.add(attemptId);
    if (this.#closed.size > 4096) this.#closed.delete(this.#closed.values().next().value!);
  }

  async isOpen(record: KafkaAcceptedFactRecord, canonical: boolean): Promise<boolean> {
    const { scope } = record.fact;
    if (this.#closed.has(scope.attemptId)) return false;
    if (this.#open.has(scope.attemptId)) return true;
    const attempt = await this.#database
      .selectFrom("run_attempts as attempt")
      .innerJoin("runs as run", "run.id", "attempt.run_id")
      .select([
        "attempt.claimed_at",
        "attempt.output_sealed_at",
        "attempt.output_first_topic",
        "attempt.output_first_partition",
        "attempt.output_first_offset",
      ])
      .where("attempt.id", "=", scope.attemptId)
      .where("attempt.tenant_id", "=", scope.tenantId)
      .where("run.id", "=", scope.runId)
      .where("run.session_id", "=", scope.sessionId)
      .where("run.turn_id", "=", scope.turnId)
      .executeTakeFirst();
    if (!attempt || attempt.output_sealed_at !== null) {
      this.close(scope.attemptId);
      return false;
    }
    if (canonical) {
      if (attempt.claimed_at.valueOf() < Date.now() - this.#retentionMs)
        throw new Error("Unsealed execution exceeds the Kafka recovery retention window");
      if (attempt.output_first_offset !== null) {
        if (
          attempt.output_first_topic !== record.topic ||
          attempt.output_first_partition !== record.partition ||
          BigInt(attempt.output_first_offset) !== record.offset
        )
          throw new Error("Unsealed execution prefix is missing or changed Kafka partition");
      } else {
        await this.#database
          .updateTable("run_attempts")
          .set({
            output_first_topic: record.topic,
            output_first_partition: record.partition,
            output_first_offset: record.offset.toString(),
          })
          .where("id", "=", scope.attemptId)
          .where("output_first_offset", "is", null)
          .execute();
      }
    }
    this.#open.add(scope.attemptId);
    return true;
  }
}

/** This fold is volatile. Its consumer must replay from the retained beginning
 * after assignment, never resume a committed offset with an empty prefix. */
export class ExecutionStreamProjector {
  readonly #database: Kysely<Database>;
  readonly #boundary: ExecutionStreamBoundary;
  readonly #mutations: PostgresPiSessionMutationProjector;
  readonly #prefixes = new Map<string, Map<number, PiCloudEvent>>();

  constructor(database: Kysely<Database>, retentionMs?: number) {
    this.#database = database;
    this.#boundary = new ExecutionStreamBoundary(database, retentionMs);
    this.#mutations = new PostgresPiSessionMutationProjector(database);
  }

  reset(): void {
    this.#boundary.reset();
    this.#prefixes.clear();
  }

  async project(record: KafkaAcceptedFactRecord): Promise<void> {
    const { fact } = record;
    if (!(await this.#boundary.isOpen(record, true))) return;
    const prefix = this.#prefixes.get(fact.scope.attemptId) ?? new Map<number, PiCloudEvent>();
    this.#prefixes.set(fact.scope.attemptId, prefix);
    for (const event of factEvents(fact)) {
      const previous = prefix.get(event.seq);
      if (previous && previous.eventId !== event.eventId)
        throw new Error("Execution stream has conflicting events at one sequence");
      prefix.set(event.seq, event);
    }
    if (fact.kind === "pi_session_mutation") {
      await this.#mutations.project(fact, true, record.offset);
    } else if (fact.kind === "execution_seal") {
      await this.#seal(
        fact,
        [...prefix.values()].sort((a, b) => a.seq - b.seq),
      );
      this.#boundary.close(fact.scope.attemptId);
      this.#prefixes.delete(fact.scope.attemptId);
    }
  }

  async #seal(fact: AcceptedExecutionSealFact, prefix: readonly PiCloudEvent[]): Promise<void> {
    await this.#database.transaction().execute(async (transaction) => {
      const attempt = await transaction
        .selectFrom("run_attempts")
        .select(["output_seal_id", "output_sealed_at", "fencing_token"])
        .where("id", "=", fact.scope.attemptId)
        .forUpdate()
        .executeTakeFirst();
      if (!attempt || attempt.output_sealed_at !== null) return;
      if (
        attempt.output_seal_id !== fact.factId ||
        Number(attempt.fencing_token ?? 0) !== fact.scope.fencingToken
      )
        throw new Error("Execution seal does not match its requested RunAttempt");
      const event = parsePiCloudEvent({
        schemaVersion: 1,
        eventId: fact.factId,
        sessionId: fact.scope.sessionId,
        turnId: fact.scope.turnId,
        agentId: fact.agentId,
        seq: Math.max(fact.baseSequence, prefix.at(-1)?.seq ?? 0) + 1,
        occurredAt: fact.occurredAt,
        ...fact.terminal,
      });
      const now = new Date();
      if (event.type !== "turn.completed") {
        await appendInterruptedAssistantPrefix(transaction, {
          tenantId: fact.scope.tenantId,
          sessionId: fact.scope.sessionId,
          turnId: fact.scope.turnId,
          transcript: projectConversationTurnTranscript([...prefix, event]),
          now,
          entryId: globalThis.crypto.randomUUID(),
        });
      }
      await transaction
        .insertInto("session_terminal_events")
        .values({
          event_id: event.eventId,
          tenant_id: fact.scope.tenantId,
          session_id: fact.scope.sessionId,
          turn_id: fact.scope.turnId,
          agent_id: event.agentId,
          run_id: fact.scope.runId,
          seq: event.seq,
          schema_version: event.schemaVersion,
          type: fact.terminal.type,
          payload: event.payload,
          occurred_at: new Date(fact.occurredAt),
          persisted_at: now,
        })
        .execute();
      await transaction
        .updateTable("sessions")
        .set({
          next_event_seq: event.seq + 1,
          row_version: sql<string>`row_version + 1`,
          updated_at: now,
        })
        .where("id", "=", fact.scope.sessionId)
        .execute();
      await transaction
        .updateTable("run_attempts")
        .set({ output_sealed_at: now, last_event_seq: event.seq })
        .where("id", "=", fact.scope.attemptId)
        .execute();
      await sql`select pg_notify('pi_cloud_run_queue', id::text) from runs
        where session_id = ${fact.scope.sessionId}::uuid and state = 'queued'`.execute(transaction);
    });
  }
}

/** Gateway may see the seal before the canonical consumer. Retrying the record
 * keeps this partition ordered without claiming that business-terminal = sealed. */
export async function readProjectedSeal(
  database: Kysely<Database>,
  fact: AcceptedExecutionSealFact,
): Promise<PiCloudEvent | undefined> {
  const row = await database
    .selectFrom("run_attempts as attempt")
    .leftJoin("session_terminal_events as event", "event.event_id", "attempt.output_seal_id")
    .select([
      "attempt.output_sealed_at",
      "event.event_id",
      "event.seq",
      "event.type",
      "event.payload",
      "event.occurred_at",
      "event.agent_id",
    ])
    .where("attempt.id", "=", fact.scope.attemptId)
    .executeTakeFirst();
  if (!row) return undefined; // Session deletion cascades its execution history.
  if (row.output_sealed_at === null)
    throw new AcceptedFactProjectionPendingError("Execution seal projection is pending");
  if (!row.event_id) return undefined;
  return parsePiCloudEvent({
    schemaVersion: 1,
    eventId: row.event_id,
    sessionId: fact.scope.sessionId,
    turnId: fact.scope.turnId,
    agentId: row.agent_id,
    seq: Number(row.seq),
    type: row.type,
    payload: row.payload,
    occurredAt: row.occurred_at!.toISOString(),
  });
}
