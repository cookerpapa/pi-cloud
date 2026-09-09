import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { PostgresPiSessionStorage } from "@pi-cloud/pi-session-postgres";
import {
  RunExecutor,
  TurnExecutionBackendError,
  type TurnExecutionRequest,
} from "@pi-cloud/runtime-core/run-executor";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { ControlPlaneStore, createPrivateTenant } from "../src/index.ts";
import {
  ExecutionStreamProjector,
  ExecutionStreamBoundary,
} from "../../runtime-core/src/execution-stream-projection.ts";
import { SessionLiveView } from "../../runtime-core/src/session-live-view.ts";
import { factEvents } from "../../runtime-core/src/execution-stream-projection.ts";
import { parseKafkaAcceptedFact } from "../../runtime-core/src/kafka-accepted-fact.ts";
import { PostgresPiSessionAppendProjector } from "../../runtime-core/src/postgres-pi-session-append-projector.ts";
import { loadFactReplayOffsets } from "../../runtime-core/src/accepted-fact-recovery.ts";
import type {
  AcceptedAgentEventFact,
  AcceptedExecutionSealFact,
  AcceptedPiSessionAppendFact,
  AcceptedFact,
} from "../../runtime-core/src/accepted-fact.ts";
import { readCanonicalPiTurnTranscripts } from "../../runtime-core/src/canonical-pi-conversation.ts";
import { KafkaSafeRetention } from "../../runtime-core/src/kafka-safe-retention.ts";
import { vi } from "vitest";

let pg: PGlite,
  socket: PGLiteSocketServer,
  db: Kysely<Database>,
  store: ControlPlaneStore,
  tenantId: string;
beforeAll(async () => {
  pg = await PGlite.create();
  socket = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0 });
  await socket.start();
  db = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 1,
  });
  await runMigrations(db, "up");
  const tenant = await createPrivateTenant(db, {
    slug: "seal-tests",
    ownerDisplayName: "Seal tests",
  });
  tenantId = tenant.tenantId;
  store = new ControlPlaneStore({
    database: db,
    tenantId,
    defaultModelProfileId: tenant.defaultModelProfileId,
  });
}, 30000);
afterAll(async () => {
  await db?.destroy();
  await socket?.stop();
  await pg?.close();
});

async function fixture() {
  const project = await store.createProject({
    name: `seal-${crypto.randomUUID()}`,
    source: { kind: "empty" },
  });
  await db
    .updateTable("environment_versions")
    .set({ state: "validated", validated_at: new Date() })
    .where("id", "=", project.environment.environmentVersionId)
    .execute();
  const session = await store.createSession(
    project.projectId,
    project.workspaceId,
    "Seal",
    "elastic",
  );
  const first = await store.acceptTurn(session.sessionId, "first", {
    prompt: "keep this accepted input",
  });
  let request!: TurnExecutionRequest;
  const executor = new RunExecutor({
    database: db,
    claimOwnerId: "seal-worker",
    backend: {
      async execute(input, lifecycle) {
        request = input;
        await lifecycle.started();
        throw new TurnExecutionBackendError("worker_lost", "Worker stopped", false);
      },
    },
  });
  await expect(executor.dispatchRun(first.runId)).resolves.toMatchObject({ status: "failed" });
  const second = await store.acceptTurn(session.sessionId, "second", { prompt: "continue" });
  const outbox = await db
    .selectFrom("outbox")
    .select("payload")
    .where(sql<boolean>`payload #>> '{scope,runId}' = ${first.runId}`)
    .executeTakeFirstOrThrow();
  const seal = parseKafkaAcceptedFact(JSON.stringify(outbox.payload)) as AcceptedExecutionSealFact;
  const storage = new PostgresPiSessionStorage({
    database: db,
    tenantId,
    sessionId: request.piSessionId,
  });
  let nextSeq = 1,
    head: string | null = null;
  const mutation = (name: string): AcceptedPiSessionAppendFact => {
    const id = crypto.randomUUID(),
      parentId = head;
    head = id;
    return {
      kind: "pi_session_append",
      factId: crypto.randomUUID(),
      scope: seal.scope,
      piSession: { id: request.piSessionId, lane: "main", writerId: request.piSessionWriterId },
      events: [],
      occurredAt: seal.occurredAt,
      items: [
        {
          kind: "entry",
          lane: "main",
          turnId: first.turnId,
          entry: {
            id,
            seq: nextSeq++,
            parentId,
            timestamp: Date.now(),
            type: "custom",
            customType: "test.fact",
            data: name,
          },
        },
      ],
    };
  };
  const delta = (seq: number, text: string): AcceptedAgentEventFact => {
    const id = crypto.randomUUID();
    return {
      kind: "agent_event",
      factId: id,
      scope: seal.scope,
      occurredAt: seal.occurredAt,
      event: {
        schemaVersion: 1,
        eventId: id,
        sessionId: session.sessionId,
        turnId: first.turnId,
        agentId: "root",
        seq,
        occurredAt: seal.occurredAt,
        type: "assistant.text.delta",
        payload: { text },
      },
    };
  };
  const record = (fact: AcceptedFact, offset: bigint) => ({
    fact,
    topic: "seals-test",
    partition: 0,
    offset,
  });
  const tail = () => {
    const view = new SessionLiveView(async () => () => {});
    const boundary = new ExecutionStreamBoundary(db);
    return Object.assign(view, {
      async projectRecord(r: ReturnType<typeof record>) {
        if (r.fact.kind === "execution_seal") {
          const terminal = await new ExecutionStreamProjector(db).project(r);
          if (terminal) view.accept(tenantId, terminal);
        } else if (await boundary.isOpen(r, false)) {
          for (const event of factEvents(r.fact)) view.accept(r.fact.scope.tenantId, event);
        }
      },
    });
  };
  return { first, second, session, executor, seal, storage, mutation, delta, record, tail };
}

describe.sequential("Execution stream closure", () => {
  it.each([false, true])(
    "keeps sibling prefixes and closes the shared writer only when uncertain=%s",
    async (closesWriter) => {
      const parent = await fixture(),
        child = await fixture(),
        projector = new ExecutionStreamProjector(db),
        tail = parent.tail();
      const writerId = parent.seal.scope.writerId,
        piSessionId = parent.seal.scope.piSessionId;
      await db
        .updateTable("sessions")
        .set({ pi_session_id: piSessionId, pi_session_lane: "child" })
        .where("id", "=", child.session.sessionId)
        .execute();
      await db
        .updateTable("run_attempts")
        .set({ native_writer_anchor_id: writerId })
        .where("id", "=", child.seal.scope.attemptId)
        .execute();
      const childScope = { ...child.seal.scope, writerId, piSessionId };
      const root = parent.mutation("root");
      const rootEntry = root.items[0]!;
      if (rootEntry.kind !== "entry") throw new Error("fixture");
      const rootWithLane = {
        ...root,
        items: [
          ...root.items,
          {
            kind: "lane" as const,
            seq: 2,
            lane: "child",
            leafId: rootEntry.entry.id,
            create: true,
          },
        ],
      };
      const childFact: AcceptedPiSessionAppendFact = {
        kind: "pi_session_append",
        factId: crypto.randomUUID(),
        scope: childScope,
        piSession: { id: piSessionId, lane: "child", writerId },
        events: [child.delta(1, "child-prefix").event],
        occurredAt: root.occurredAt,
        items: [
          {
            kind: "entry",
            lane: "child",
            turnId: child.first.turnId,
            entry: {
              ...rootEntry.entry,
              id: crypto.randomUUID(),
              seq: 3,
              parentId: rootEntry.entry.id,
            },
          },
        ],
      };
      const childSeal = { ...child.seal, scope: childScope, closesWriter };
      const records = [
        parent.record(rootWithLane, 10n),
        parent.record(parent.delta(1, "parent-prefix"), 11n),
        parent.record(childFact, 12n),
        parent.record(childSeal, 13n),
      ];
      for (const record of records) {
        await projector.project(record);
        await tail.projectRecord(record);
      }
      const late: AcceptedPiSessionAppendFact = {
        ...root,
        factId: crypto.randomUUID(),
        items: [
          {
            kind: "entry",
            lane: "main",
            turnId: parent.first.turnId,
            entry: {
              ...rootEntry.entry,
              id: crypto.randomUUID(),
              seq: 4,
              parentId: rootEntry.entry.id,
            },
          },
        ],
        events: [],
      };
      await projector.project(parent.record(late, 14n));
      await new PostgresPiSessionAppendProjector(db).project(late, true, parent.record(late, 14n));
      await projector.project(parent.record(parent.seal, 15n));
      expect(await parent.storage.getLog()).toHaveLength(closesWriter ? 3 : 4);
      expect(
        (
          await db
            .selectFrom("session_terminal_events")
            .select("interrupted_prefix")
            .where("event_id", "=", parent.seal.factId)
            .executeTakeFirst()
        )?.interrupted_prefix,
      ).toBe("parent-prefix");
      const closed = await db
        .selectFrom("run_attempts")
        .select("native_writer_seal_offset")
        .where("id", "=", writerId)
        .executeTakeFirstOrThrow();
      expect(closed.native_writer_seal_offset).toBe(closesWriter ? "13" : null);
      // Replaying after PG closure retains only the original valid live prefix.
      if (closesWriter) {
        const boundary = new ExecutionStreamBoundary(db);
        expect(
          await boundary.isOpen(
            parent.record({ ...parent.delta(2, "late"), scope: parent.seal.scope }, 14n),
            false,
          ),
        ).toBe(false);
        expect(await boundary.isOpen(records[1]!, false)).toBe(true);
      }
    },
  );

  it("retains unsealed data beyond the grace, then deletes only behind PG and broker time", async () => {
    const f = await fixture(),
      topic = `gc-${crypto.randomUUID()}`,
      projector = new ExecutionStreamProjector(db);
    const at = (fact: AcceptedFact, offset: bigint) => ({ ...f.record(fact, offset), topic });
    await projector.project(at(f.delta(1, "keep prefix"), 100n));
    await projector.project(at(f.mutation("complete record"), 101n));
    const deleteRecords = vi.fn(async () => []);
    const reaper = new KafkaSafeRetention({
      database: db,
      brokers: ["unused"],
      topic,
      clientId: "test",
      graceMs: 1000,
      admin: {
        async listOffsets(input) {
          return [
            {
              name: topic,
              partitions: [
                {
                  partitionIndex: 0,
                  leaderEpoch: 0,
                  timestamp: 1n,
                  offset: input.topics[0]!.partitions[0]!.timestamp === -1n ? 150n : 120n,
                },
              ],
            },
          ];
        },
        deleteRecords,
        async close() {},
      },
    });
    reaper.start(1);
    try {
      await reaper.sweep();
      expect(deleteRecords).toHaveBeenLastCalledWith({
        topics: [{ name: topic, partitions: [{ partition: 0, offset: 100n }] }],
      });
      await projector.project(at(f.seal, 125n));
      await reaper.sweep();
      expect(deleteRecords).toHaveBeenLastCalledWith({
        topics: [{ name: topic, partitions: [{ partition: 0, offset: 120n }] }],
      });
    } finally {
      await reaper.close();
    }
  });
  it("rolls back terminal, closure and projection progress when terminal insertion fails", async () => {
    const f = await fixture();
    const first = f.record(f.delta(1, "keep me"), 10n),
      seal = f.record(f.seal, 11n);
    const broken = db.withPlugin({
      transformQuery({ node, queryId }) {
        const query = db.getExecutor().compileQuery(node, queryId).sql;
        if (query.startsWith('insert into "session_terminal_events"'))
          throw new Error("injected terminal-insert failure");
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    const failed = new ExecutionStreamProjector(broken);
    await failed.project(first);
    await expect(failed.project(seal)).rejects.toThrow("terminal-insert failure");
    expect(
      await db
        .selectFrom("run_attempts")
        .select("output_sealed_at")
        .where("id", "=", f.seal.scope.attemptId)
        .executeTakeFirst(),
    ).toEqual({ output_sealed_at: null });
    expect(
      await db
        .selectFrom("session_terminal_events")
        .select("event_id")
        .where("event_id", "=", f.seal.factId)
        .executeTakeFirst(),
    ).toBeUndefined();
    const restored = new ExecutionStreamProjector(db);
    await restored.project(first);
    await restored.project(seal);
    expect(await restored.project(seal)).toMatchObject({ type: "turn.failed" });
  });

  it("returns the committed terminal directly and never appends another commit notification", async () => {
    const f = await fixture(),
      projector = new ExecutionStreamProjector(db);
    const first = await projector.project(f.record(f.seal, 20n));
    const repeated = await new ExecutionStreamProjector(db).project(f.record(f.seal, 21n));
    expect(repeated).toEqual(first);
    expect(first).toMatchObject({ type: "turn.failed" });
    const rows = await db
      .selectFrom("outbox")
      .select("payload")
      .where("tenant_id", "=", tenantId)
      .execute();
    expect(rows.some((r) => r.payload.kind === "execution_committed")).toBe(false);
  });

  it("stops projection at an invalid prepared append instead of advancing past a native log hole", async () => {
    const f = await fixture(),
      target = crypto.randomUUID();
    const fact: AcceptedPiSessionAppendFact = {
      ...f.mutation("rejected"),
      items: [{ kind: "lane", lane: "main", leafId: target, create: false, seq: 1 }],
    };
    const record = f.record(fact, 80n);
    await expect(
      new PostgresPiSessionAppendProjector(db).project(fact, true, record),
    ).rejects.toThrow("target is missing");
    expect(await f.storage.getLog()).toHaveLength(0);
    expect(
      await db
        .selectFrom("run_attempts")
        .select("output_projected_offset")
        .where("id", "=", fact.scope.attemptId)
        .executeTakeFirst(),
    ).toEqual({ output_projected_offset: null });
  });
  it("invalidates an OPEN cache when an idle live partition is resumed", async () => {
    const f = await fixture(),
      boundary = new ExecutionStreamBoundary(db),
      projector = new ExecutionStreamProjector(db);
    const text = f.record(f.delta(1, "prefix"), 90n);
    expect(await boundary.isOpen(text, false)).toBe(true);
    await projector.project(text);
    await projector.project(f.record(f.seal, 91n));
    boundary.resetPartition(0);
    expect(await boundary.isOpen(f.record(f.delta(2, "late"), 92n), false)).toBe(false);
    expect(await boundary.isOpen(text, false)).toBe(true);
  });
  it("projects two already-available semantic items with bounded SQL round trips", async () => {
    const f = await fixture(),
      statements: string[] = [];
    const operationId = crypto.randomUUID();
    const measured = db.withPlugin({
      transformQuery({ node, queryId }) {
        statements.push(db.getExecutor().compileQuery(node, queryId).sql);
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    const candidate = f.mutation("batch");
    const entry = candidate.items[0]!;
    if (entry.kind !== "entry") throw new Error("fixture");
    const fact: AcceptedPiSessionAppendFact = {
      ...candidate,
      items: [
        {
          kind: "record",
          turnId: f.first.turnId,
          record: {
            id: operationId,
            seq: 1,
            timestamp: 1,
            lane: "main",
            type: "operation_started",
            sourceLeafId: null,
            intent: { kind: "run", originalPrompt: [], initialMessages: [] },
          },
        },
        { ...entry, entry: { ...entry.entry, seq: 2 } },
        {
          kind: "record",
          turnId: f.first.turnId,
          record: {
            id: crypto.randomUUID(),
            seq: 3,
            timestamp: 1,
            lane: "main",
            type: "operation_finished",
            runId: operationId,
            outcome: "completed",
          },
        },
      ],
    };
    await new PostgresPiSessionAppendProjector(measured).project(fact, true, f.record(fact, 10n));
    expect(statements.length).toBeLessThanOrEqual(17);
    expect(
      statements.filter((query) => query.startsWith('insert into "pi_session_entries"')),
    ).toHaveLength(1);
    expect(
      statements.filter((query) => query.startsWith('insert into "pi_session_records"')),
    ).toHaveLength(1);
  });
  it("shows valid pre-seal records when the live consumer starts behind PG projection", async () => {
    const f = await fixture(),
      projector = new ExecutionStreamProjector(db);
    const text = f.record(f.delta(1, "valid before seal"), 100n),
      seal = f.record(f.seal, 101n);
    await projector.project(text);
    await projector.project(seal);
    const tail = f.tail(),
      subscription = tail.eventHub.subscribe(tenantId, f.session.sessionId);
    await tail.projectRecord(text);
    await tail.projectRecord(seal);
    expect((await subscription.next())?.event).toMatchObject({
      seq: 1,
      type: "assistant.text.delta",
    });
    expect((await subscription.next())?.event).toMatchObject({ seq: 2, type: "turn.failed" });
    await tail.projectRecord(f.record(f.delta(3, "late"), 102n));
    expect(tail.snapshot(tenantId, f.session.sessionId).events).toEqual([]);
    subscription.close();
  });

  it("recovers from the oldest unsealed start, then advances past closed history", async () => {
    const f = await fixture(),
      topic = `recovery-${crypto.randomUUID()}`,
      projector = new ExecutionStreamProjector(db);
    const at = (fact: AcceptedFact, offset: bigint) => ({ ...f.record(fact, offset), topic });
    await projector.project(at(f.delta(1, "prefix"), 100n));
    await projector.project(at(f.mutation("semantic"), 101n));
    const before = await loadFactReplayOffsets(db, topic, [{ partition: 0, low: 0n, high: 150n }]);
    expect(before.get(0)).toBe(100n);
    expect(
      (await loadFactReplayOffsets(db, topic, [{ partition: 0, low: 101n, high: 150n }])).get(0),
    ).toBeInstanceOf(Error);
    await projector.project(at(f.seal, 102n));
    expect(
      (await loadFactReplayOffsets(db, topic, [{ partition: 0, low: 0n, high: 150n }])).get(0),
    ).toBe(103n);
    // A newer PG commit must not skip records appended after the captured Kafka H.
    expect(
      (await loadFactReplayOffsets(db, topic, [{ partition: 0, low: 0n, high: 102n }])).get(0),
    ).toBe(102n);
  });
  it("waits for ordered projection, saves the visible prefix and rejects a late old writer in both paths", async () => {
    const f = await fixture(),
      projector = new ExecutionStreamProjector(db),
      tail = f.tail();
    const before = f.record(f.mutation("before seal"), 10n),
      text = f.record(f.delta(1, "visible prefix"), 11n),
      seal = f.record(f.seal, 12n);
    await projector.project(before);
    await projector.project(text);
    await tail.projectRecord(text);
    const snapshot = tail.snapshot(tenantId, f.session.sessionId);
    await expect(f.executor.dispatchRun(f.second.runId)).resolves.toMatchObject({ status: "idle" });
    // Periodic progress deliberately remains zero, behind the actual Kafka seq=1.
    await projector.project(seal);
    await tail.projectRecord(seal);
    expect(tail.snapshot(tenantId, f.session.sessionId)).toMatchObject({
      canonicalThroughSequence: 2,
      events: [],
    });
    expect(snapshot.events).toHaveLength(1);
    const entries = await db
      .selectFrom("pi_session_entries")
      .select(["id", "payload"])
      .where("session_id", "=", f.session.sessionId)
      .orderBy("seq")
      .execute();
    expect(entries.map((row) => row.payload.customType)).toEqual(["test.fact"]);
    expect(
      (
        await db
          .selectFrom("session_terminal_events")
          .select("interrupted_prefix")
          .where("event_id", "=", f.seal.factId)
          .executeTakeFirst()
      )?.interrupted_prefix,
    ).toBe("visible prefix");
    expect(
      (await readCanonicalPiTurnTranscripts(db, { tenantId, turnIds: [f.first.turnId] })).get(
        f.first.turnId,
      )?.items,
    ).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "text", text: "visible prefix" })]),
    );
    const late = f.record(f.mutation("after seal"), 13n);
    await projector.project(late);
    // A stale consumer that already cached OPEN must also lose at the DB write boundary.
    await new PostgresPiSessionAppendProjector(db).project(
      late.fact as AcceptedPiSessionAppendFact,
      true,
      late,
    );
    await tail.projectRecord(f.record(f.delta(1, "late conflicting sequence"), 14n));
    await projector.project(f.record(f.seal, 15n)); // lost seal ACK / duplicate publication
    expect(
      await db
        .selectFrom("pi_session_entries")
        .select("id")
        .where("session_id", "=", f.session.sessionId)
        .execute(),
    ).toHaveLength(1);
    expect(tail.snapshot(tenantId, f.session.sessionId).events).toEqual([]);
    await expect(f.executor.dispatchRun(f.second.runId)).resolves.toMatchObject({
      status: "failed",
      runId: f.second.runId,
    });
    expect(
      await db
        .selectFrom("turns")
        .select("input_text")
        .where("id", "=", f.first.turnId)
        .executeTakeFirst(),
    ).toEqual({ input_text: "keep this accepted input" });
  });

  it("rebuilds an interrupted prefix after consumer restart, never duplicates a semantic append", async () => {
    const f = await fixture();
    const facts = [
      f.record(f.mutation("once"), 20n),
      f.record(f.delta(1, "one "), 21n),
      f.record(f.delta(2, "two"), 22n),
    ];
    const first = new ExecutionStreamProjector(db);
    for (const record of facts) await first.project(record);
    const recovered = new ExecutionStreamProjector(db);
    for (const record of facts) await recovered.project(record);
    await recovered.project(f.record(f.seal, 23n));
    const rows = await db
      .selectFrom("pi_session_entries")
      .select("payload")
      .where("session_id", "=", f.session.sessionId)
      .orderBy("seq")
      .execute();
    expect(rows).toHaveLength(1);
    expect(
      (
        await db
          .selectFrom("session_terminal_events")
          .select("interrupted_prefix")
          .where("event_id", "=", f.seal.factId)
          .executeTakeFirst()
      )?.interrupted_prefix,
    ).toBe("one two");
    // Even if Kafka no longer retains the seal, durable closure rejects late data.
    await new ExecutionStreamProjector(db).project(f.record(f.mutation("late after restart"), 90n));
    const tail = f.tail();
    await tail.projectRecord(f.record(f.delta(1, "late"), 91n));
    expect(tail.snapshot(tenantId, f.session.sessionId).events).toEqual([]);
  });

  it("fails closed when restart has lost the recorded unsealed prefix to retention", async () => {
    const f = await fixture();
    await new ExecutionStreamProjector(db).project(f.record(f.delta(1, "retained?"), 30n));
    await expect(new ExecutionStreamProjector(db).project(f.record(f.seal, 40n))).rejects.toThrow(
      "prefix is missing",
    );
    await expect(f.executor.dispatchRun(f.second.runId)).resolves.toMatchObject({ status: "idle" });
  });

  it("does not rewind canonical state on old append replay without a second receipt ledger", async () => {
    const f = await fixture(),
      projector = new ExecutionStreamProjector(db);
    const a = f.record(
      {
        ...f.mutation("a"),
        items: [{ kind: "fact", fact: "name", name: "A", seq: 1 }],
      } as AcceptedPiSessionAppendFact,
      60n,
    );
    const b = f.record(
      {
        ...f.mutation("b"),
        items: [{ kind: "fact", fact: "name", name: "B", seq: 2 }],
      } as AcceptedPiSessionAppendFact,
      61n,
    );
    await projector.project(a);
    await projector.project(b);
    const recovered = new ExecutionStreamProjector(db);
    await recovered.project(a);
    expect(await f.storage.getName()).toBe("B");
    await recovered.project(b);
    await recovered.project(f.record(f.seal, 62n));
    expect(await f.storage.getName()).toBe("B");
  });

  it("does not expire an unprojected execution merely because wall time exceeds retention grace", async () => {
    const f = await fixture();
    await db
      .updateTable("run_attempts")
      .set({ claimed_at: new Date(Date.now() - 86400000) })
      .where("id", "=", f.seal.scope.attemptId)
      .execute();
    await expect(
      new ExecutionStreamProjector(db).project(f.record(f.seal, 80n)),
    ).resolves.toMatchObject({ type: "turn.failed" });
  });

  it("does not close a new Run when a duplicate old seal arrives", async () => {
    const f = await fixture(),
      projector = new ExecutionStreamProjector(db);
    await projector.project(f.record(f.seal, 50n));
    await f.executor.dispatchRun(f.second.runId);
    const newSeal = await db
      .selectFrom("outbox")
      .select("payload")
      .where(sql<boolean>`payload #>> '{scope,runId}' = ${f.second.runId}`)
      .executeTakeFirstOrThrow();
    const fact = parseKafkaAcceptedFact(
      JSON.stringify(newSeal.payload),
    ) as AcceptedExecutionSealFact;
    await projector.project(f.record(f.seal, 51n));
    expect(
      await db
        .selectFrom("run_attempts")
        .select("output_sealed_at")
        .where("id", "=", fact.scope.attemptId)
        .executeTakeFirst(),
    ).toEqual({ output_sealed_at: null });
    await projector.project(f.record(fact, 52n));
    expect(
      await db
        .selectFrom("session_terminal_events")
        .select("seq")
        .where("session_id", "=", f.session.sessionId)
        .orderBy("seq")
        .execute(),
    ).toEqual([{ seq: "1" }, { seq: "2" }]);
  });
});
