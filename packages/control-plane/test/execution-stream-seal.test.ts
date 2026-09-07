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
import { KafkaLiveSessionTail } from "../../runtime-core/src/kafka-live-session-tail.ts";
import { parseKafkaAcceptedFact } from "../../runtime-core/src/kafka-accepted-fact.ts";
import { PostgresPiSessionMutationProjector } from "../../runtime-core/src/postgres-pi-session-mutation-projector.ts";
import { loadFactReplayOffsets } from "../../runtime-core/src/accepted-fact-recovery.ts";
import type {
  AcceptedAgentEventFact,
  AcceptedExecutionSealFact,
  AcceptedPiSessionMutationFact,
  AcceptedFact,
} from "../../runtime-core/src/accepted-fact.ts";

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
});
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
  const mutation = (name: string): AcceptedPiSessionMutationFact => ({
    kind: "pi_session_mutation",
    factId: crypto.randomUUID(),
    scope: seal.scope,
    piSession: { id: request.piSessionId, lane: "main" },
    events: [],
    occurredAt: seal.occurredAt,
    operation: {
      kind: "append_entry",
      lane: "main",
      entry: {
        id: crypto.randomUUID(),
        type: "custom",
        customType: "test.fact",
        data: name,
      },
    },
  });
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
  const tail = () =>
    new KafkaLiveSessionTail({
      database: db,
      brokers: ["127.0.0.1:1"],
      topic: "seals-test",
      clientId: crypto.randomUUID(),
      instanceId: crypto.randomUUID(),
    });
  return { first, second, session, executor, seal, storage, mutation, delta, record, tail };
}

describe.sequential("Execution stream closure", () => {
  it("does not reinterpret a rejected mutation after its receipt expires", async () => {
    const f = await fixture(),
      target = crypto.randomUUID();
    const fact: AcceptedPiSessionMutationFact = {
      ...f.mutation("rejected"),
      operation: { kind: "move_lane", lane: "main", to: target },
    };
    const record = f.record(fact, 80n);
    await new PostgresPiSessionMutationProjector(db).project(fact, true, record);
    await f.storage.appendEntry(
      { id: target, type: "custom", customType: "later", data: null },
      "main",
    );
    const head = await f.storage.appendEntry(
      { id: crypto.randomUUID(), type: "custom", customType: "head", data: null },
      "main",
    );
    await db
      .deleteFrom("pi_session_mutation_results")
      .where("mutation_id", "=", fact.factId)
      .execute();
    await new PostgresPiSessionMutationProjector(db).project(fact, true, record);
    expect((await f.storage.getLanes()).find((row) => row.lane === "main")?.leafId).toBe(head.id);
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
    await f.storage.appendRecord({
      id: operationId,
      lane: "main",
      type: "operation_started",
      sourceLeafId: null,
      intent: { kind: "run", originalPrompt: [], initialMessages: [] },
    });
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
    if (candidate.operation.kind !== "append_entry") throw new Error("fixture operation changed");
    const fact: AcceptedPiSessionMutationFact = {
      ...candidate,
      operation: {
        kind: "append_items",
        items: [
          candidate.operation,
          {
            kind: "append_record",
            record: {
              id: crypto.randomUUID(),
              lane: "main",
              type: "operation_finished",
              runId: operationId,
              outcome: "completed",
            },
          },
        ],
      },
    };
    await new PostgresPiSessionMutationProjector(measured).project(fact, true, f.record(fact, 10n));
    expect(statements).toHaveLength(13); // Includes the new partition recovery checkpoint; excludes BEGIN/COMMIT.
    expect(statements.filter((query) => query.includes("update pi_sessions"))).toHaveLength(1);
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
    await expect(tail.projectRecord(seal)).rejects.toThrow("projection is pending");
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
    expect(entries.map((row) => row.payload.customType)).toEqual([
      "test.fact",
      "pi-cloud.interrupted_assistant_prefix",
    ]);
    expect(entries[1]?.payload.data).toEqual({ text: "visible prefix" });
    const late = f.record(f.mutation("after seal"), 13n);
    await projector.project(late);
    // A stale consumer that already cached OPEN must also lose at the DB write boundary.
    await new PostgresPiSessionMutationProjector(db).project(
      late.fact as AcceptedPiSessionMutationFact,
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
    ).toHaveLength(2);
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
    expect(rows).toHaveLength(2);
    expect(rows[1]?.payload.data).toEqual({ text: "one two" });
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

  it("does not rewind canonical state when replay outlives short receipt retention", async () => {
    const f = await fixture(),
      projector = new ExecutionStreamProjector(db);
    const a = f.record(
      {
        ...f.mutation("a"),
        operation: { kind: "set_name", name: "A" },
      } as AcceptedPiSessionMutationFact,
      60n,
    );
    const b = f.record(
      {
        ...f.mutation("b"),
        operation: { kind: "set_name", name: "B" },
      } as AcceptedPiSessionMutationFact,
      61n,
    );
    await projector.project(a);
    await projector.project(b);
    await db
      .deleteFrom("pi_session_mutation_results")
      .where("run_id", "=", f.first.runId)
      .execute();
    const recovered = new ExecutionStreamProjector(db);
    await recovered.project(a);
    expect(await f.storage.getName()).toBe("B");
    await recovered.project(b);
    await recovered.project(f.record(f.seal, 62n));
    expect(await f.storage.getName()).toBe("B");
  });

  it("rejects recovery outside retention even before a first offset was recorded", async () => {
    const f = await fixture();
    await expect(
      new ExecutionStreamProjector(db, 1).project(f.record(f.seal, 80n)),
    ).rejects.toThrow("retention window");
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
