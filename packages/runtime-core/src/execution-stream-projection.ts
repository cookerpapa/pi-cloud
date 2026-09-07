import type { Database } from "@pi-cloud/database";
import { parsePiCloudEvent, type PiCloudEvent } from "@pi-cloud/protocol";
import { sql, type Kysely } from "kysely";
import type { AcceptedExecutionSealFact, AcceptedFact } from "./accepted-fact.ts";
import type { KafkaAcceptedFactRecord } from "./kafka-accepted-fact-consumer.ts";
import { appendInterruptedAssistantPrefix } from "./canonical-pi-conversation.ts";
import { projectConversationTurnTranscript } from "./conversation-turn-projection.ts";
import { PostgresPiSessionMutationProjector } from "./postgres-pi-session-mutation-projector.ts";
import { recordFactProjection, type FactPosition } from "./accepted-fact-recovery.ts";
import { enqueueExecutionCommit } from "./execution-stream-commit.ts";

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
  readonly #closed = new Map<string, bigint>();
  readonly #partitions = new Map<string, number>();
  readonly #retentionMs: number;

  constructor(database: Kysely<Database>, retentionMs = 24 * 60 * 60_000) {
    this.#database = database;
    this.#retentionMs = retentionMs;
  }

  reset(): void {
    this.#open.clear();
    this.#closed.clear();
    this.#partitions.clear();
  }

  resetPartition(partition: number): void {
    for (const [id, part] of this.#partitions)
      if (part === partition) {
        this.#open.delete(id);
        this.#closed.delete(id);
        this.#partitions.delete(id);
      }
  }

  close(attemptId: string, offset = -1n, partition?: number): void {
    if (partition !== undefined) this.#partitions.set(attemptId, partition);
    this.#open.delete(attemptId);
    const previous = this.#closed.get(attemptId);
    this.#closed.delete(attemptId);
    this.#closed.set(attemptId, previous === undefined || offset < previous ? offset : previous);
    if (this.#closed.size > 65_536) {
      const oldest = this.#closed.keys().next().value!;
      this.#closed.delete(oldest);
      this.#partitions.delete(oldest);
    }
  }

  async isOpen(record: KafkaAcceptedFactRecord, canonical: boolean): Promise<boolean> {
    const { scope } = record.fact;
    const cutoff = this.#closed.get(scope.attemptId);
    if (cutoff !== undefined) {
      this.#closed.delete(scope.attemptId);
      this.#closed.set(scope.attemptId, cutoff);
      return !canonical && record.offset < cutoff;
    }
    if (this.#open.has(scope.attemptId)) return true;
    const attempt = await this.#database
      .selectFrom("run_attempts as attempt")
      .innerJoin("runs as run", "run.id", "attempt.run_id")
      .select([
        "attempt.claimed_at",
        "attempt.output_sealed_at",
        "attempt.output_seal_offset",
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
      const cutoff = attempt?.output_seal_offset == null ? -1n : BigInt(attempt.output_seal_offset);
      this.close(scope.attemptId, cutoff, record.partition);
      return !canonical && record.offset < cutoff;
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
    this.#partitions.set(scope.attemptId, record.partition);
    return true;
  }
}

/** Rebuild volatile prefixes from the PG recovery floor, never a consumer-group offset. */
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
    if (fact.kind === "execution_committed") return; // Notification, not another mutation.
    if (!(await this.#boundary.isOpen(record, true))) {
      if (fact.kind === "execution_seal") await this.#seal(fact, record, []);
      return;
    }
    const prefix = this.#prefixes.get(fact.scope.attemptId) ?? new Map<number, PiCloudEvent>();
    this.#prefixes.set(fact.scope.attemptId, prefix);
    for (const event of factEvents(fact)) {
      const previous = prefix.get(event.seq);
      if (previous && previous.eventId !== event.eventId)
        throw new Error("Execution stream has conflicting events at one sequence");
      prefix.set(event.seq, event);
    }
    if (fact.kind === "pi_session_mutation") {
      await this.#mutations.project(fact, true, record);
    } else if (fact.kind === "execution_seal") {
      await this.#seal(
        fact,
        record,
        [...prefix.values()].sort((a, b) => a.seq - b.seq),
      );
      this.#boundary.close(fact.scope.attemptId, record.offset, record.partition);
      this.#prefixes.delete(fact.scope.attemptId);
    }
  }

  async #seal(
    fact: AcceptedExecutionSealFact,
    position: FactPosition,
    prefix: readonly PiCloudEvent[],
  ): Promise<void> {
    await this.#database.transaction().execute(async (transaction) => {
      const attempt = await transaction
        .selectFrom("run_attempts")
        .select([
          "output_seal_id",
          "output_sealed_at",
          "fencing_token",
          "output_seal_offset",
          "output_first_topic",
          "output_first_partition",
        ])
        .where("id", "=", fact.scope.attemptId)
        .forUpdate()
        .executeTakeFirst();
      if (!attempt) return;
      if (
        attempt.output_seal_id !== fact.factId ||
        Number(attempt.fencing_token ?? 0) !== fact.scope.fencingToken
      )
        throw new Error("Execution seal does not match its requested RunAttempt");
      if (attempt.output_sealed_at !== null) {
        const terminal = await transaction
          .selectFrom("session_terminal_events")
          .selectAll()
          .where("event_id", "=", fact.factId)
          .executeTakeFirstOrThrow();
        const event = parsePiCloudEvent({
          schemaVersion: terminal.schema_version,
          eventId: terminal.event_id,
          sessionId: terminal.session_id,
          turnId: terminal.turn_id,
          agentId: terminal.agent_id,
          seq: Number(terminal.seq),
          occurredAt: terminal.occurred_at.toISOString(),
          type: terminal.type,
          payload: terminal.payload,
        });
        if (
          event.type !== "turn.completed" &&
          event.type !== "turn.failed" &&
          event.type !== "turn.cancelled"
        )
          throw new Error("Stored execution terminal has an invalid type");
        await enqueueExecutionCommit(
          transaction,
          fact,
          {
            topic: attempt.output_first_topic!,
            partition: attempt.output_first_partition!,
            offset: BigInt(attempt.output_seal_offset!),
          },
          event,
        );
        await recordFactProjection(transaction, position);
        return;
      }
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
        .set({
          output_sealed_at: now,
          output_seal_offset: position.offset.toString(),
          last_event_seq: event.seq,
        })
        .where("id", "=", fact.scope.attemptId)
        .execute();
      await recordFactProjection(transaction, position);
      if (
        event.type !== "turn.completed" &&
        event.type !== "turn.failed" &&
        event.type !== "turn.cancelled"
      )
        throw new Error("Execution seal must carry a terminal event");
      await enqueueExecutionCommit(transaction, fact, position, event);
      await sql`select pg_notify('pi_cloud_run_queue', id::text) from runs
        where session_id = ${fact.scope.sessionId}::uuid and state = 'queued'`.execute(transaction);
    });
  }
}
