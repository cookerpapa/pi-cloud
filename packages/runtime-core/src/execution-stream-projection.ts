import type { Database } from "@pi-cloud/database";
import { parsePiCloudEvent, type PiCloudEvent } from "@pi-cloud/protocol";
import { sql, type Kysely } from "kysely";
import type { AcceptedExecutionSealFact, AcceptedFact } from "./accepted-fact.ts";
import type { KafkaAcceptedFactRecord } from "./kafka-accepted-fact-consumer.ts";
import { readInterruptedAssistantPrefix } from "./canonical-pi-conversation.ts";
import { projectConversationTurnTranscript } from "./conversation-turn-projection.ts";
import { PostgresPiSessionAppendProjector } from "./postgres-pi-session-append-projector.ts";
import { recordFactProjection, type FactPosition } from "./accepted-fact-recovery.ts";

export function factEvents(fact: AcceptedFact): readonly PiCloudEvent[] {
  return fact.kind === "agent_event"
    ? [fact.event]
    : fact.kind === "pi_session_append"
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
  readonly #writers = new Map<string, { offset: bigint; partition: number }>();

  constructor(database: Kysely<Database>) {
    this.#database = database;
  }

  reset(): void {
    this.#open.clear();
    this.#closed.clear();
    this.#partitions.clear();
    this.#writers.clear();
  }

  resetPartition(partition: number): void {
    for (const [id, writer] of this.#writers)
      if (writer.partition === partition) this.#writers.delete(id);
    for (const [id, part] of this.#partitions)
      if (part === partition) {
        this.#open.delete(id);
        this.#closed.delete(id);
        this.#partitions.delete(id);
      }
  }
  closeWriter(writerId: string, offset: bigint, partition: number) {
    const prior = this.#writers.get(writerId);
    if (!prior || offset < prior.offset) this.#writers.set(writerId, { offset, partition });
    // Open scopes must reload the durable group cutoff after eviction.
    if (this.#writers.size > 65_536) {
      this.#writers.delete(this.#writers.keys().next().value!);
      this.#open.clear();
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
    const writerCutoff = this.#writers.get(scope.writerId);
    if (writerCutoff && record.offset >= writerCutoff.offset) return false;
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
      .innerJoin("run_attempts as writer", "writer.id", "attempt.native_writer_id")
      .select([
        "attempt.claimed_at",
        "attempt.output_sealed_at",
        "attempt.output_seal_offset",
        "attempt.output_first_topic",
        "attempt.output_first_partition",
        "attempt.output_first_offset",
        "attempt.native_writer_id",
        "writer.native_writer_seal_offset",
      ])
      .where("attempt.id", "=", scope.attemptId)
      .where("attempt.tenant_id", "=", scope.tenantId)
      .where("run.id", "=", scope.runId)
      .where("run.session_id", "=", scope.sessionId)
      .where("run.turn_id", "=", scope.turnId)
      .executeTakeFirst();
    if (attempt && attempt.native_writer_id !== scope.writerId)
      throw new Error("Execution native writer identity changed");
    if (attempt?.native_writer_seal_offset != null) {
      const offset = BigInt(attempt.native_writer_seal_offset);
      this.closeWriter(scope.writerId, offset, record.partition);
      if (record.offset >= offset) return false;
    }
    if (!attempt || attempt.output_sealed_at !== null) {
      const cutoff = attempt?.output_seal_offset == null ? -1n : BigInt(attempt.output_seal_offset);
      this.close(scope.attemptId, cutoff, record.partition);
      return !canonical && record.offset < cutoff;
    }
    if (canonical) {
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
  readonly #mutations: PostgresPiSessionAppendProjector;
  readonly #prefixes = new Map<string, Map<number, PiCloudEvent>>();

  constructor(database: Kysely<Database>) {
    this.#database = database;
    this.#boundary = new ExecutionStreamBoundary(database);
    this.#mutations = new PostgresPiSessionAppendProjector(database);
  }

  reset(): void {
    this.#boundary.reset();
    this.#prefixes.clear();
  }

  accepts(record: KafkaAcceptedFactRecord): Promise<boolean> {
    return this.#boundary.isOpen(record, false);
  }

  async project(record: KafkaAcceptedFactRecord): Promise<PiCloudEvent | undefined> {
    const { fact } = record;
    if (!(await this.#boundary.isOpen(record, true))) {
      if (fact.kind === "execution_seal") {
        const prefix = this.#prefixes.get(fact.scope.attemptId);
        const terminal = await this.#seal(
          fact,
          record,
          [...(prefix?.values() ?? [])].sort((a, b) => a.seq - b.seq),
        );
        this.#boundary.close(fact.scope.attemptId, record.offset, record.partition);
        if (fact.closesWriter)
          this.#boundary.closeWriter(fact.scope.writerId, record.offset, record.partition);
        this.#prefixes.delete(fact.scope.attemptId);
        return terminal;
      }
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
    if (fact.kind === "pi_session_append") {
      await this.#mutations.project(fact, true, record);
    } else if (fact.kind === "execution_seal") {
      const terminal = await this.#seal(
        fact,
        record,
        [...prefix.values()].sort((a, b) => a.seq - b.seq),
      );
      this.#boundary.close(fact.scope.attemptId, record.offset, record.partition);
      if (fact.closesWriter)
        this.#boundary.closeWriter(fact.scope.writerId, record.offset, record.partition);
      this.#prefixes.delete(fact.scope.attemptId);
      return terminal;
    }
  }

  async #seal(
    fact: AcceptedExecutionSealFact,
    position: FactPosition,
    prefix: readonly PiCloudEvent[],
  ): Promise<PiCloudEvent | undefined> {
    const committed = await this.#database.transaction().execute(async (transaction) => {
      const attempt = await transaction
        .selectFrom("run_attempts")
        .select([
          "output_seal_id",
          "output_sealed_at",
          "fencing_token",
          "output_seal_offset",
          "output_first_topic",
          "output_first_partition",
          "output_first_offset",
        ])
        .where("id", "=", fact.scope.attemptId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!attempt) return;
      // Terminal admission and native projection lock their own Attempt before
      // the common writer anchor. Never take a sibling Attempt after that anchor.
      const writer = await transaction
        .selectFrom("run_attempts")
        .select("native_writer_seal_offset")
        .where("tenant_id", "=", fact.scope.tenantId)
        .where("id", "=", fact.scope.writerId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!writer) return;
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
        await recordFactProjection(transaction, position);
        return event;
      }
      if (
        attempt.output_first_offset !== null &&
        !this.#prefixes.has(fact.scope.attemptId) &&
        BigInt(attempt.output_first_offset) !== position.offset
      )
        throw new Error("Unsealed execution prefix is missing before writer closure");
      if (fact.closesWriter && writer.native_writer_seal_offset === null)
        await transaction
          .updateTable("run_attempts")
          .set({
            native_writer_sealed_at: new Date(),
            native_writer_seal_offset: position.offset.toString(),
          })
          .where("id", "=", fact.scope.writerId)
          .execute();
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
      const interruptedPrefix =
        event.type !== "turn.completed"
          ? await readInterruptedAssistantPrefix(transaction, {
              tenantId: fact.scope.tenantId,
              sessionId: fact.scope.sessionId,
              turnId: fact.scope.turnId,
              transcript: projectConversationTurnTranscript([...prefix, event]),
            })
          : null;
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
          interrupted_prefix: interruptedPrefix,
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
          output_first_topic: attempt.output_first_topic ?? position.topic,
          output_first_partition: attempt.output_first_partition ?? position.partition,
          output_first_offset: attempt.output_first_offset ?? position.offset.toString(),
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
      await sql`select pg_notify('pi_cloud_run_queue', id::text) from runs
        where session_id = ${fact.scope.sessionId}::uuid and state = 'queued'`.execute(transaction);
      return event;
    });
    return committed;
  }
}
