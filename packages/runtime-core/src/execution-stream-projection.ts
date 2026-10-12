import { transitionCurrentRun } from "./run-state.ts";
import { PostgresDurableCommitProjector } from "./postgres-durable-commit-projector.ts";
import type { Database } from "@pi-cloud/database";
import { recoverQuarantinedSession } from "./quarantined-session-recovery.ts";
import { advanceLaneReadiness } from "./run-readiness.ts";
import { parsePiCloudEvent, type PiCloudEvent } from "@pi-cloud/protocol";
import { sql, type Kysely } from "kysely";
import type { AcceptedExecutionSealFact, AcceptedFact } from "./accepted-fact.ts";
import type { KafkaAcceptedFactRecord } from "./kafka-accepted-fact-consumer.ts";
import { recordFactProjection, type FactPosition } from "./accepted-fact-recovery.ts";
import { CompactEventTail } from "./compact-event-tail.ts";
import { projectionTransaction } from "./projection-transaction.ts";

export type ExecutionProjectionResult = {
  terminal?: PiCloudEvent;
  canonicalThroughSequence?: number;
  events?: PiCloudEvent[];
  covers?: { sessionId: string; through: number }[];
};

export function factEvents(fact: AcceptedFact): readonly PiCloudEvent[] {
  return fact.kind === "agent_event" ? [fact.event] : [];
}

/** Durable closure is checked once per execution, not once per token. Closed
 * tombstones can be evicted: their authority is the Run row, not RAM. */
export class ExecutionStreamBoundary {
  readonly #database: Kysely<Database>;
  readonly #open = new Set<string>();
  readonly #closed = new Map<string, bigint>();
  readonly #writers = new Map<string, bigint>();

  constructor(database: Kysely<Database>) {
    this.#database = database;
  }

  reset(): void {
    this.#open.clear();
    this.#closed.clear();
    this.#writers.clear();
  }

  closeWriter(writerId: string, offset: bigint) {
    const prior = this.#writers.get(writerId);
    if (prior === undefined || offset < prior) this.#writers.set(writerId, offset);
    // Open scopes must reload the durable group cutoff after eviction.
    if (this.#writers.size > 65_536) {
      this.#writers.delete(this.#writers.keys().next().value!);
      this.#open.clear();
    }
  }

  observes(runId: string, writerId: string): boolean {
    return (
      this.#open.has(`${writerId}:${runId}`) &&
      !this.#closed.has(`${writerId}:${runId}`) &&
      !this.#writers.has(writerId)
    );
  }

  close(runId: string, writerId: string, offset: bigint): void {
    runId = `${writerId}:${runId}`;
    this.#open.delete(runId);
    const previous = this.#closed.get(runId);
    this.#closed.delete(runId);
    this.#closed.set(runId, previous === undefined || offset < previous ? offset : previous);
    if (this.#closed.size > 65_536) {
      const oldest = this.#closed.keys().next().value!;
      this.#closed.delete(oldest);
    }
  }

  async isOpen(record: KafkaAcceptedFactRecord, canonical: boolean): Promise<boolean> {
    const { scope } = record.fact;
    const identity = `${scope.writerId}:${scope.runId}`;
    const writerCutoff = this.#writers.get(scope.writerId);
    if (writerCutoff !== undefined && record.offset >= writerCutoff) return false;
    const cutoff = this.#closed.get(identity);
    if (cutoff !== undefined) {
      this.#closed.delete(identity);
      this.#closed.set(identity, cutoff);
      return !canonical && record.offset < cutoff;
    }
    if (this.#open.has(identity)) return true;
    const run = await this.#database
      .selectFrom("runs as run")
      .innerJoin("session_leases as writer", (join) =>
        join
          .on("writer.lease_id", "=", scope.writerId)
          .onRef("writer.tenant_id", "=", "run.tenant_id"),
      )
      .select([
        "run.started_at",
        "run.output_sealed_at",
        "run.output_seal_offset",
        "run.output_first_topic",
        "run.output_first_partition",
        "run.output_first_offset",
        "run.lease_id",
        "writer.writer_seal_offset",
      ])
      .where("run.id", "=", scope.runId)
      .where("run.tenant_id", "=", scope.tenantId)
      .where("run.session_id", "=", scope.sessionId)
      .where("run.turn_id", "=", scope.turnId)
      .executeTakeFirst();
    if (run && run.lease_id !== scope.writerId) {
      if (run.writer_seal_offset === null)
        throw new Error("Previous execution owner has no closure proof");
      this.closeWriter(scope.writerId, BigInt(run.writer_seal_offset));
      return false;
    }
    if (run?.writer_seal_offset != null) {
      const offset = BigInt(run.writer_seal_offset);
      this.closeWriter(scope.writerId, offset);
      if (record.offset >= offset) return false;
    }
    if (!run || run.output_sealed_at !== null) {
      const cutoff = run?.output_seal_offset == null ? -1n : BigInt(run.output_seal_offset);
      this.close(scope.runId, scope.writerId, cutoff);
      return !canonical && record.offset < cutoff;
    }
    if (canonical) {
      if (run.output_first_offset !== null) {
        if (
          run.output_first_topic !== record.topic ||
          run.output_first_partition !== record.partition ||
          BigInt(run.output_first_offset) !== record.offset
        )
          throw new Error("Unsealed execution prefix is missing or changed Kafka partition");
      }
    }
    this.#open.add(identity);
    return true;
  }
}

/** Rebuild volatile prefixes from the PG recovery floor, never a consumer-group offset. */
export class ExecutionStreamProjector {
  readonly #database: Kysely<Database>;
  readonly #boundary: ExecutionStreamBoundary;
  readonly #durable: PostgresDurableCommitProjector;
  readonly #prefixes = new Map<string, CompactEventTail>();

  constructor(database: Kysely<Database>) {
    this.#database = database;
    this.#boundary = new ExecutionStreamBoundary(database);
    this.#durable = new PostgresDurableCommitProjector(database);
  }

  reset(): void {
    this.#boundary.reset();
    this.#durable.reset();
    this.#prefixes.clear();
  }

  accepts(record: KafkaAcceptedFactRecord): Promise<boolean> {
    return this.#boundary.isOpen(record, false);
  }

  observes(record: KafkaAcceptedFactRecord): boolean {
    return this.#boundary.observes(record.fact.scope.runId, record.fact.scope.writerId);
  }

  async project(
    record: KafkaAcceptedFactRecord,
    current: () => boolean = () => true,
  ): Promise<ExecutionProjectionResult | undefined> {
    const { fact } = record;
    if (fact.kind === "path_probe") return;
    if (fact.kind === "durable_commit") {
      const scopes = new Map(
        [fact.scope, ...fact.display.map((d) => d.scope)].map((scope) => [scope.runId, scope]),
      );
      const open = new Set<string>();
      // A parent can anchor a child's first display. Install that child's
      // boundary at the same offset, before its floor is saved in PostgreSQL.
      for (const scope of scopes.values())
        if (await this.#boundary.isOpen({ ...record, fact: { ...fact, scope } }, true))
          open.add(scope.runId);
      if (!open.size) {
        await this.#durable.replay(fact, record, current);
        return;
      }
      const projected = await this.#durable.project(fact, record, current);
      const sessions = new Set(
        [...scopes.values()]
          .filter((scope) => open.has(scope.runId))
          .map((scope) => scope.sessionId),
      );
      const result = {
        events: projected.events.filter((event) => sessions.has(event.sessionId)),
        covers: projected.covers.filter((cover) => sessions.has(cover.sessionId)),
      };
      // The native anchor need not be the Conversation that produced text.
      for (const scope of scopes.values()) {
        if (!open.has(scope.runId)) continue;
        const key = `${scope.writerId}:${scope.runId}`;
        const prefix = this.#prefixes.get(key) ?? new CompactEventTail();
        for (const event of result.events)
          if (event.sessionId === scope.sessionId) prefix.accept(event);
        for (const cover of result.covers)
          if (cover.sessionId === scope.sessionId) prefix.cover(cover.through);
        this.#prefixes.set(key, prefix);
      }
      return result;
    }
    if (!(await this.#boundary.isOpen(record, true))) {
      if (fact.kind === "execution_seal") {
        const prefix = this.#prefixes.get(`${fact.scope.writerId}:${fact.scope.runId}`);
        const terminal = await this.#seal(fact, record, prefix, current);
        this.#boundary.close(fact.scope.runId, fact.scope.writerId, record.offset);
        if (fact.closesWriter) this.#boundary.closeWriter(fact.scope.writerId, record.offset);
        this.#prefixes.delete(`${fact.scope.writerId}:${fact.scope.runId}`);
        return terminal ? { terminal, canonicalThroughSequence: terminal.seq } : undefined;
      }
      return;
    }
    const existingPrefix = this.#prefixes.get(`${fact.scope.writerId}:${fact.scope.runId}`);
    const prefix = existingPrefix ?? new CompactEventTail();
    for (const event of factEvents(fact)) {
      prefix.accept(event);
    }
    if (fact.kind === "execution_seal") {
      const terminal = await this.#seal(fact, record, prefix, current);
      this.#boundary.close(fact.scope.runId, fact.scope.writerId, record.offset);
      if (fact.closesWriter) this.#boundary.closeWriter(fact.scope.writerId, record.offset);
      this.#prefixes.delete(`${fact.scope.writerId}:${fact.scope.runId}`);
      return terminal ? { terminal, canonicalThroughSequence: terminal.seq } : undefined;
    } else {
      if (fact.kind === "agent_event" && fact.nativeSequence !== undefined) {
        // A replay is valid only under the same authority/native-commit checks.
        // Lock before deciding: a concurrent advance or owner change must be
        // rechecked, even when this statement would otherwise be a no-op.
        const covered = await sql`with covered_run as materialized (
          select id,output_display_seq,output_display_native_seq from runs
          where tenant_id=${fact.scope.tenantId}::uuid and id=${fact.scope.runId}::uuid
            and lease_id=${fact.scope.writerId}::uuid
            and exists(select 1 from pi_durable_commits c where c.tenant_id=${fact.scope.tenantId}::uuid
              and c.session_id=${fact.scope.piSessionId} and c.seq=${fact.nativeSequence})
          for no key update
        ), advanced as (
          update runs r set output_display_seq=greatest(r.output_display_seq,${fact.event.seq}),
            output_display_native_seq=greatest(r.output_display_native_seq,${fact.nativeSequence})
          from covered_run c where r.id=c.id
            and (c.output_display_seq<${fact.event.seq} or c.output_display_native_seq<${fact.nativeSequence})
          returning r.id
        ) select id from covered_run`.execute(this.#database);
        if (covered.rows.length !== 1)
          throw new Error("Display checkpoint preceded its native commit");
        prefix.cover(fact.event.seq);
        this.#prefixes.set(`${fact.scope.writerId}:${fact.scope.runId}`, prefix);
        return { canonicalThroughSequence: fact.event.seq };
      }
      if (!existingPrefix) {
        // Normally the first record is a native append and anchors in that
        // transaction. A display/control-only prefix must also survive recovery
        // before it can become visible or reach an external-effect executor.
        await this.#database
          .updateTable("runs")
          .set({
            output_first_topic: record.topic,
            output_first_partition: record.partition,
            output_first_offset: record.offset.toString(),
          })
          .where("tenant_id", "=", fact.scope.tenantId)
          .where("id", "=", fact.scope.runId)
          .where("output_first_offset", "is", null)
          .execute();
      }
      this.#prefixes.set(`${fact.scope.writerId}:${fact.scope.runId}`, prefix);
    }
  }

  async #seal(
    fact: AcceptedExecutionSealFact,
    position: FactPosition,
    prefix: CompactEventTail | undefined,
    current: () => boolean,
  ): Promise<PiCloudEvent | undefined> {
    let adopt = () => {};
    const committed = await projectionTransaction(this.#database, async (transaction) => {
      const run = await transaction
        .selectFrom("runs")
        .select([
          "output_seal_id",
          "lease_id",
          "state",
          "output_sealed_at",
          "fencing_token",
          "output_seal_offset",
          "output_first_topic",
          "output_first_partition",
          "output_first_offset",
        ])
        .where("id", "=", fact.scope.runId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!run) return;
      // Terminal admission and native projection lock their own Run before the
      // shared lease. Never take a sibling Run after that lease.
      const writer = await transaction
        .selectFrom("session_leases")
        .select("writer_seal_offset")
        .where("tenant_id", "=", fact.scope.tenantId)
        .where("lease_id", "=", fact.scope.writerId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!writer) return;
      if (run.lease_id !== fact.scope.writerId && writer.writer_seal_offset !== null) {
        await recordFactProjection(transaction, position);
        return;
      }
      if (
        run.output_seal_id !== fact.factId ||
        Number(run.fencing_token ?? 0) !== fact.scope.fencingToken
      )
        throw new Error("Execution seal does not match its requested Run");
      if (run.output_sealed_at !== null) {
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
        run.output_first_offset !== null &&
        !this.#prefixes.has(`${fact.scope.writerId}:${fact.scope.runId}`) &&
        BigInt(run.output_first_offset) !== position.offset
      )
        throw new Error("Unsealed execution prefix is missing before writer closure");
      if (fact.closesWriter)
        adopt = await this.#durable.checkpointLiveIn(transaction, fact.scope, current);
      if (fact.closesWriter && writer.writer_seal_offset === null)
        await transaction
          .updateTable("session_leases")
          .set({
            writer_sealed_at: new Date(),
            writer_seal_offset: position.offset.toString(),
          })
          .where("lease_id", "=", fact.scope.writerId)
          .execute();
      if (fact.recover) {
        const now = new Date(),
          through = Math.max(fact.baseSequence, prefix?.highWaterMark ?? 0);
        // Release/count the old incarnation before clearing its binding. The
        // database trigger requires the immutable writer seal above.
        await transaction
          .updateTable("runs")
          .set({
            output_sealed_at: now,
            output_seal_offset: position.offset.toString(),
            last_event_seq: through,
          })
          .where("tenant_id", "=", fact.scope.tenantId)
          .where("id", "=", fact.scope.runId)
          .execute();
        await transaction
          .updateTable("turn_control_requests")
          .set({
            state: "pending",
            dispatched_at: null,
            acknowledged_at: null,
            available_at: now,
            failure_code: null,
          })
          .where("tenant_id", "=", fact.scope.tenantId)
          .where("target_run_id", "=", fact.scope.runId)
          .where("kind", "=", "cancel")
          .where("state", "in", ["dispatched", "acknowledged"])
          .execute();
        await transitionCurrentRun(
          transaction,
          { tenantId: fact.scope.tenantId, runId: fact.scope.runId },
          { runState: "queued", reason: "native_execution_recovery", now },
        );
        await transaction
          .updateTable("runs")
          .set({
            worker_id: null,
            lease_id: null,
            fencing_token: null,
            execution_released_at: null,
            agent_exited_at: null,
            output_seal_id: null,
            output_sealed_at: null,
            output_seal_offset: null,
            output_first_topic: null,
            output_first_partition: null,
            output_first_offset: null,
            output_publication: null,
            native_output_drained: false,
            ready_at: null,
          })
          .where("tenant_id", "=", fact.scope.tenantId)
          .where("id", "=", fact.scope.runId)
          .execute();
        await transaction
          .updateTable("sessions")
          .set({
            state: "idle",
            row_version: sql`row_version+1`,
            next_event_seq: sql`greatest(next_event_seq,${through + 1})`,
            updated_at: now,
          })
          .where("tenant_id", "=", fact.scope.tenantId)
          .where("id", "=", fact.scope.sessionId)
          .execute();
        await recordFactProjection(transaction, position);
        await advanceLaneReadiness(transaction, fact.scope.tenantId, fact.scope.sessionId);
        return;
      }
      const event = parsePiCloudEvent({
        schemaVersion: 1,
        eventId: fact.factId,
        sessionId: fact.scope.sessionId,
        turnId: fact.scope.turnId,
        agentId: fact.agentId,
        seq: Math.max(fact.baseSequence, prefix?.highWaterMark ?? 0) + 1,
        occurredAt: fact.occurredAt,
        ...fact.terminal,
      });
      const now = new Date();
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
          interrupted_prefix: null,
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
        .updateTable("runs")
        .set({
          output_sealed_at: now,
          output_seal_offset: position.offset.toString(),
          output_first_topic: run.output_first_topic ?? position.topic,
          output_first_partition: run.output_first_partition ?? position.partition,
          output_first_offset: run.output_first_offset ?? position.offset.toString(),
          last_event_seq: event.seq,
        })
        .where("id", "=", fact.scope.runId)
        .execute();
      await recordFactProjection(transaction, position);
      if (event.type === "turn.failed") await recoverQuarantinedSession(transaction, fact.scope);
      if (
        event.type !== "turn.completed" &&
        event.type !== "turn.failed" &&
        event.type !== "turn.cancelled"
      )
        throw new Error("Execution seal must carry a terminal event");
      await advanceLaneReadiness(transaction, fact.scope.tenantId, fact.scope.sessionId);
      return event;
    });
    adopt();
    if (current()) this.#durable.releaseSettled(fact.scope);
    return committed;
  }
}
