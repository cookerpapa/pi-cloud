import { transitionLockedRun } from "./run-state.ts";
import { PostgresDurableCommitProjector } from "./postgres-durable-commit-projector.ts";
import type { Database } from "@pi-cloud/database";
import { recoverQuarantinedSession } from "./quarantined-session-recovery.ts";
import { advanceLaneReadiness } from "./run-readiness.ts";
import { parsePiCloudEvent, type PiCloudEvent } from "@pi-cloud/protocol";
import { sql, type Kysely, type Transaction } from "kysely";
import type {
  AcceptedExecutionSealFact,
  AcceptedWorkFinishedFact,
  AcceptedFact,
} from "./accepted-fact.ts";
import { finishWorkIn } from "./work-finished-projection.ts";
import { releaseIdleSessionLease } from "./session-lease-release.ts";
import type { KafkaAcceptedFactRecord } from "./kafka-accepted-fact-consumer.ts";
import { recordFactProjection, type FactPosition } from "./accepted-fact-recovery.ts";
import { ExecutionPrefix } from "./execution-prefix.ts";
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
      .where("writer.pi_session_id", "=", scope.piSessionId)
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
  readonly #prefixes = new Map<string, ExecutionPrefix>();

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

  statistics() {
    return {
      prefixes: this.#prefixes.size,
      pendingEventIds: [...this.#prefixes.values()].reduce((n, p) => n + p.pendingEventIds, 0),
    };
  }

  #closeWriter(writerId: string, offset: bigint): void {
    this.#boundary.closeWriter(writerId, offset);
    for (const key of this.#prefixes.keys())
      if (key.startsWith(`${writerId}:`)) this.#prefixes.delete(key);
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
    if (fact.kind === "path_probe" || fact.kind === "runtime_keepalive") return;
    if (fact.kind === "work_finished") return this.#finishWork(fact, record, current);
    if (fact.kind === "durable_commit") {
      const scopes = new Map(
        [fact.scope, ...fact.display.map((d) => d.scope)].map((scope) => [scope.sessionId, scope]),
      );
      if (!(await this.#boundary.isOpen(record, true))) {
        await this.#durable.replay(fact, record, current);
        return;
      }
      const projected = await this.#durable.project(fact, record, current);
      const sessions = new Set([...scopes.values()].map((scope) => scope.sessionId));
      const result = {
        events: projected.events.filter((event) => sessions.has(event.sessionId)),
        covers: projected.covers.filter((cover) => sessions.has(cover.sessionId)),
      };
      // The native anchor need not be the Conversation that produced text.
      for (const scope of scopes.values()) {
        const key = `${scope.writerId}:${scope.runId}:${scope.sessionId}`;
        const prefix = this.#prefixes.get(key) ?? new ExecutionPrefix();
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
        const prefix = this.#prefixes.get(
          `${fact.scope.writerId}:${fact.scope.runId}:${fact.scope.sessionId}`,
        );
        const terminal = await this.#seal(fact, record, prefix, current);
        this.#boundary.close(fact.scope.runId, fact.scope.writerId, record.offset);
        this.#closeWriter(fact.scope.writerId, record.offset);
        return terminal ? { terminal, canonicalThroughSequence: terminal.seq } : undefined;
      }
      return;
    }
    const existingPrefix = this.#prefixes.get(
      `${fact.scope.writerId}:${fact.scope.runId}:${fact.scope.sessionId}`,
    );
    const prefix = existingPrefix ?? new ExecutionPrefix();
    for (const event of factEvents(fact)) {
      prefix.accept(event);
    }
    if (fact.kind === "execution_seal") {
      const terminal = await this.#seal(fact, record, prefix, current);
      this.#boundary.close(fact.scope.runId, fact.scope.writerId, record.offset);
      this.#closeWriter(fact.scope.writerId, record.offset);
      return terminal ? { terminal, canonicalThroughSequence: terminal.seq } : undefined;
    } else {
      if (fact.kind === "agent_event" && fact.nativeSequence !== undefined) {
        // A replay is valid only under the same authority/native-commit checks.
        // Lock before deciding: a concurrent advance or owner change must be
        // rechecked, even when this statement would otherwise be a no-op.
        const covered = await sql`with owner as materialized (
          select id from runs where tenant_id=${fact.scope.tenantId}::uuid and id=${fact.scope.runId}::uuid
            and lease_id=${fact.scope.writerId}::uuid
            and exists(select 1 from pi_durable_commits c where c.tenant_id=${fact.scope.tenantId}::uuid
              and c.session_id=${fact.scope.piSessionId} and c.seq=${fact.nativeSequence})
          for no key update
        ), admitted as materialized (
          select v.* from conversation_turns v join owner on owner.id=v.id
          where v.tenant_id=${fact.scope.tenantId}::uuid and v.session_id=${fact.scope.sessionId}::uuid
            and v.turn_id=${fact.scope.turnId}::uuid
        ), root as (
          update runs r set output_display_seq=greatest(r.output_display_seq,${fact.event.seq}),
            output_display_native_seq=greatest(r.output_display_native_seq,${fact.nativeSequence})
          from admitted c where r.id=c.id and r.session_id=c.session_id and r.turn_id=c.turn_id
            and (r.output_display_seq<${fact.event.seq} or r.output_display_native_seq<${fact.nativeSequence}) returning r.id
        ), child as (
          update subagent_conversations v set output_display_seq=greatest(v.output_display_seq,${fact.event.seq}),
            output_display_native_seq=greatest(v.output_display_native_seq,${fact.nativeSequence})
          from admitted c where v.root_run_id=c.id and v.child_session_id=c.session_id and v.child_turn_id=c.turn_id
            and (v.output_display_seq<${fact.event.seq} or v.output_display_native_seq<${fact.nativeSequence}) returning v.id
        ) select id from admitted`.execute(this.#database);
        if (covered.rows.length !== 1)
          throw new Error("Display checkpoint preceded its native commit");
        if (
          fact.event.type === "turn.completed" ||
          fact.event.type === "turn.failed" ||
          fact.event.type === "turn.cancelled"
        ) {
          const event = fact.event;
          await projectionTransaction(this.#database, async (tx) => {
            const child = await tx
              .selectFrom("subagent_conversations")
              .select("id")
              .where("tenant_id", "=", fact.scope.tenantId)
              .where("root_run_id", "=", fact.scope.runId)
              .where("child_session_id", "=", fact.scope.sessionId)
              .where("child_turn_id", "=", fact.scope.turnId)
              .forUpdate()
              .executeTakeFirst();
            if (!child)
              throw new Error("Only child Conversations finish through native presentation");
            await tx
              .insertInto("session_terminal_events")
              .values({
                event_id: event.eventId,
                tenant_id: fact.scope.tenantId,
                session_id: event.sessionId,
                turn_id: event.turnId,
                agent_id: event.agentId,
                run_id: fact.scope.runId,
                seq: event.seq,
                schema_version: event.schemaVersion,
                type: event.type as "turn.completed" | "turn.failed" | "turn.cancelled",
                payload: event.payload,
                occurred_at: new Date(event.occurredAt),
                persisted_at: new Date(),
                interrupted_prefix: null,
              })
              .onConflict((conflict) => conflict.column("event_id").doNothing())
              .execute();
            await tx
              .updateTable("sessions")
              .set({ next_event_seq: sql`greatest(next_event_seq,${event.seq + 1})` })
              .where("tenant_id", "=", fact.scope.tenantId)
              .where("id", "=", event.sessionId)
              .execute();
            await recordFactProjection(tx, record);
            if (!current()) throw new Error("Conversation completion owner changed");
          });
          this.#prefixes.delete(
            `${fact.scope.writerId}:${fact.scope.runId}:${fact.scope.sessionId}`,
          );
          return { terminal: event, canonicalThroughSequence: event.seq };
        }
        prefix.cover(fact.event.seq);
        this.#prefixes.set(
          `${fact.scope.writerId}:${fact.scope.runId}:${fact.scope.sessionId}`,
          prefix,
        );
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
      this.#prefixes.set(
        `${fact.scope.writerId}:${fact.scope.runId}:${fact.scope.sessionId}`,
        prefix,
      );
    }
  }

  async #finishWork(
    fact: AcceptedWorkFinishedFact,
    position: FactPosition,
    current: () => boolean,
  ): Promise<ExecutionProjectionResult | undefined> {
    let adopt = () => {},
      rootClosed: bigint | undefined,
      writerClosed: bigint | undefined;
    const key = `${fact.scope.writerId}:${fact.scope.runId}:${fact.scope.sessionId}`;
    const event = await projectionTransaction(this.#database, async (tx) => {
      const run = await tx
        .selectFrom("runs")
        .select([
          "lease_id",
          "fencing_token",
          "session_id",
          "turn_id",
          "output_sealed_at",
          "output_seal_offset",
          "state",
          "row_version",
          "output_first_topic",
          "output_first_partition",
        ])
        .where("tenant_id", "=", fact.scope.tenantId)
        .where("id", "=", fact.scope.runId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      const writer = await tx
        .selectFrom("session_leases")
        .select(["writer_failed_at", "writer_seal_offset", "pi_session_id", "fencing_token"])
        .where("tenant_id", "=", fact.scope.tenantId)
        .where("lease_id", "=", fact.scope.writerId)
        .forNoKeyUpdate()
        .executeTakeFirst();
      if (!run || !writer) return;
      if (writer.writer_seal_offset !== null) {
        writerClosed = BigInt(writer.writer_seal_offset);
        adopt = this.#durable.closedWriterCleanup(fact.scope, current);
      }
      if (
        run.lease_id !== fact.scope.writerId ||
        (writerClosed !== undefined && position.offset > writerClosed)
      ) {
        if (writerClosed === undefined)
          throw new Error("Work completion owner changed without closure proof");
        await recordFactProjection(tx, position);
        return;
      }
      if (
        run.session_id !== fact.scope.sessionId ||
        run.turn_id !== fact.scope.turnId ||
        writer.pi_session_id !== fact.scope.piSessionId ||
        Number(writer.fencing_token) !== fact.scope.fencingToken
      )
        throw new Error("Root completion scope changed");
      if (
        run.output_first_topic !== null &&
        (run.output_first_topic !== position.topic ||
          run.output_first_partition !== position.partition)
      )
        throw new Error("Root completion moved between Kafka streams");
      if (run.output_sealed_at !== null) {
        if (run.output_seal_offset !== null) rootClosed = BigInt(run.output_seal_offset);
        await recordFactProjection(tx, position);
        return this.#readTerminal(tx, fact.scope);
      }
      if (fact.nativeSequence > 0) {
        const head = await sql<{
          seq: string;
        }>`select coalesce(max(seq),0)::text seq from pi_durable_commits
          where tenant_id=${fact.scope.tenantId}::uuid and session_id=${fact.scope.piSessionId}`.execute(
          tx,
        );
        if (Number(head.rows[0]!.seq) !== fact.nativeSequence)
          throw new Error("Root completion does not follow its final native commit");
      }
      const retire = writer.writer_failed_at === null;
      adopt = await this.#durable.checkpointLiveIn(tx, fact.scope, current);
      if (retire) await this.#handoffViews(tx, fact.scope);
      const result = await finishWorkIn(
        tx,
        run,
        fact,
        position,
        this.#prefixes.get(key)?.highWaterMark ?? 0,
        retire,
      );
      if (result) {
        rootClosed = position.offset;
        if (retire) writerClosed = position.offset;
      }
      if (!current()) throw new Error("Work completion Projector owner changed");
      return result;
    });
    adopt();
    if (!current()) return;
    if (rootClosed !== undefined) {
      this.#boundary.close(fact.scope.runId, fact.scope.writerId, rootClosed);
      this.#prefixes.delete(key);
    }
    if (writerClosed !== undefined) this.#closeWriter(fact.scope.writerId, writerClosed);
    this.#durable.releaseSettled(fact.scope);
    return event ? { terminal: event, canonicalThroughSequence: event.seq } : undefined;
  }

  async #seal(
    fact: AcceptedExecutionSealFact,
    position: FactPosition,
    prefix: ExecutionPrefix | undefined,
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
          "row_version",
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
      if (writer.writer_seal_offset !== null)
        adopt = this.#durable.closedWriterCleanup(fact.scope, current);
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
        if (writer.writer_seal_offset === null) {
          adopt = await this.#durable.checkpointLiveIn(transaction, fact.scope, current);
          const now = new Date();
          await transaction
            .updateTable("session_leases")
            .set({ writer_sealed_at: now, writer_seal_offset: position.offset.toString() })
            .where("tenant_id", "=", fact.scope.tenantId)
            .where("lease_id", "=", fact.scope.writerId)
            .execute();
          await releaseIdleSessionLease(transaction, fact.scope.writerId, now);
        }
        await recordFactProjection(transaction, position);
        return this.#readTerminal(transaction, fact.scope);
      }
      if (
        run.output_first_offset !== null &&
        !this.#prefixes.has(`${fact.scope.writerId}:${fact.scope.runId}:${fact.scope.sessionId}`) &&
        BigInt(run.output_first_offset) !== position.offset
      )
        throw new Error("Unsealed execution prefix is missing before writer closure");
      {
        adopt = await this.#durable.checkpointLiveIn(transaction, fact.scope, current);
        await this.#handoffViews(transaction, fact.scope);
      }
      if (writer.writer_seal_offset === null)
        await transaction
          .updateTable("session_leases")
          .set({
            writer_sealed_at: new Date(),
            writer_seal_offset: position.offset.toString(),
          })
          .where("lease_id", "=", fact.scope.writerId)
          .execute();
      {
        // The ordered Kafka fence is the ownership proof. An unreachable old
        // Worker need not acknowledge its local callback cleanup; this says
        // nothing about the lifetime of physical Cube processes.
        await transaction
          .updateTable("runs")
          .set({ execution_released_at: new Date() })
          .where("tenant_id", "=", fact.scope.tenantId)
          .where("id", "=", fact.scope.runId)
          .where("lease_id", "=", fact.scope.writerId)
          .where("execution_released_at", "is", null)
          .execute();
        await releaseIdleSessionLease(transaction, fact.scope.writerId, new Date());
      }
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
        await transitionLockedRun(
          transaction,
          { tenantId: fact.scope.tenantId, runId: fact.scope.runId },
          run,
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

  /** Replay reconstructs the committed presentation without allocating another
   * event or changing the winning terminal decision. */
  async #readTerminal(
    tx: Transaction<Database>,
    scope: AcceptedFact["scope"],
  ): Promise<PiCloudEvent> {
    const terminal = await tx
      .selectFrom("session_terminal_events")
      .selectAll()
      .where("tenant_id", "=", scope.tenantId)
      .where("run_id", "=", scope.runId)
      .where("session_id", "=", scope.sessionId)
      .where("turn_id", "=", scope.turnId)
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
    if (!["turn.completed", "turn.failed", "turn.cancelled"].includes(event.type))
      throw new Error("Stored execution terminal has an invalid type");
    return event;
  }

  /** Event sequences belong to views. A Session handoff must advance every
   * observed child, including a child that has no terminal presentation yet. */
  async #handoffViews(tx: Transaction<Database>, scope: AcceptedFact["scope"]): Promise<void> {
    const start = `${scope.writerId}:${scope.runId}:`;
    const rows = [...this.#prefixes].flatMap(([key, tail]) =>
      key.startsWith(start)
        ? [{ sessionId: key.slice(start.length), through: tail.highWaterMark }]
        : [],
    );
    if (!rows.length) return;
    await sql`update sessions s set next_event_seq=greatest(s.next_event_seq,views.through+1)
      from (values ${sql.join(rows.map((row) => sql`(${row.sessionId}::uuid,${row.through}::bigint)`))}) views(id,through)
      where s.tenant_id=${scope.tenantId}::uuid and s.pi_session_id=${scope.piSessionId} and s.id=views.id`.execute(
      tx,
    );
  }
}
