import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { DurablePostgresProjection } from "@pi-cloud/pi-session-postgres/durable";
import { TurnExecutionBackendError } from "@pi-cloud/runtime-core/run-executor";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import { ControlPlaneStore, createPrivateTenant } from "../src/index.ts";
import { createTestWorker } from "./admit-test-execution.ts";
import {
  ExecutionStreamProjector,
  ExecutionStreamBoundary,
} from "../../runtime-core/src/execution-stream-projection.ts";
import { PostgresDurableCommitProjector } from "../../runtime-core/src/postgres-durable-commit-projector.ts";
import { SessionLiveView } from "../../runtime-core/src/session-live-view.ts";
import { parseKafkaAcceptedFact } from "../../runtime-core/src/kafka-accepted-fact.ts";
import { loadFactReplayOffsets } from "../../runtime-core/src/accepted-fact-recovery.ts";
import { KafkaSafeRetention } from "../../runtime-core/src/kafka-safe-retention.ts";
import { readCanonicalPiTurnTranscripts } from "../../runtime-core/src/canonical-pi-conversation.ts";
import type {
  AcceptedFact,
  AcceptedAgentEventFact,
  AcceptedDurableCommitFact,
  AcceptedExecutionSealFact,
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
  const tenant = await createPrivateTenant(db, { slug: "native-seals", ownerDisplayName: "Seals" });
  tenantId = tenant.tenantId;
  store = new ControlPlaneStore({ database: db, ...tenant });
}, 60000);
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
  const worker = await createTestWorker(db);
  const executor = worker.executor({
    unavailablePublication: true,
    execute: async () => {
      throw new TurnExecutionBackendError("fixture_failure", "Synthetic terminal failure", false);
    },
  });
  expect((await executor.dispatchRun(first.runId)).status).toBe("failed");
  const second = await store.acceptTurn(session.sessionId, "second", { prompt: "continue" });
  const row = await db
    .selectFrom("outbox")
    .select("payload")
    .where(sql<boolean>`payload#>>'{scope,runId}'=${first.runId}`)
    .executeTakeFirstOrThrow();
  const seal = parseKafkaAcceptedFact(JSON.stringify(row.payload)) as AcceptedExecutionSealFact;
  let seq = 0,
    nextId = 2;
  const mutation = (text: string, stopReason?: string): AcceptedDurableCommitFact => {
    const id = nextId++,
      writes: Record<string, unknown>[] = [];
    if (seq === 0) writes.push({ type: "conversation", value: { id: 1 } });
    writes.push({
      type: "entry",
      value: {
        id,
        conversationId: 1,
        kind: stopReason ? "pi.assistant" : "test.fact",
        ...(stopReason
          ? {
              model: [
                {
                  role: "assistant",
                  content: [{ type: "text", text }],
                  stopReason,
                  timestamp: Date.now(),
                  api: "test",
                  provider: "test",
                  model: "test",
                },
              ],
            }
          : { data: text }),
      },
    });
    return {
      kind: "durable_commit",
      factId: crypto.randomUUID(),
      scope: seal.scope,
      commit: { seq: ++seq, nextId, writes },
      origins: [
        { recordId: id, sessionId: session.sessionId, turnId: first.turnId, runId: first.runId },
      ],
      tools: [],
      cancellations: [],
      display: [],
      occurredAt: seal.occurredAt,
    };
  };
  const delta = (seq: number, text: string): AcceptedAgentEventFact => {
    const eventId = crypto.randomUUID();
    return {
      kind: "agent_event",
      factId: eventId,
      scope: seal.scope,
      occurredAt: seal.occurredAt,
      event: {
        schemaVersion: 1,
        eventId,
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
    offset,
    topic: "seals-test",
    partition: 0,
  });
  const projection = new DurablePostgresProjection(db, { tenantId, sessionId: session.sessionId });
  return { first, second, session, executor, seal, mutation, delta, record, projection };
}
describe.sequential("native execution closure", () => {
  const liveFacts = (f: Awaited<ReturnType<typeof fixture>>) => {
    const first = f.mutation("before live generation");
    const seed: AcceptedDurableCommitFact = {
      ...first,
      commit: {
        ...first.commit,
        nextId: 101,
        writes: [
          ...first.commit.writes,
          {
            type: "document.create",
            record: {
              id: 100,
              kind: "pi.live",
              scope: { kind: "conversation", conversationId: 1 },
              history: "latest",
              fork: "initial",
            },
            content: { kind: "base", version: 1, value: {} },
          },
        ],
      },
    };
    const progress: AcceptedDurableCommitFact = {
      ...first,
      factId: crypto.randomUUID(),
      origins: [],
      commit: {
        seq: 2,
        nextId: 101,
        writes: [
          {
            type: "document.change",
            id: 100,
            content: {
              kind: "delta",
              version: 1,
              ops: [
                ["s", ["generation"], { attempt: 1, message: { text: "accepted live suffix" } }],
              ],
            },
          },
        ],
      },
    };
    return { seed, progress };
  };
  it("requires replayed live state before writer closure and commits one handoff checkpoint", async () => {
    const f = await fixture(),
      { seed, progress } = liveFacts(f);
    expect(f.seal.closesWriter).toBe(true);
    const old = new ExecutionStreamProjector(db);
    await old.project(f.record(seed, 10n));
    await old.project(f.record(progress, 20n));
    const pg = new DurablePostgresProjection(db, { tenantId, sessionId: f.seal.scope.piSessionId });
    await expect(pg.assertComplete()).rejects.toThrow("Kafka recovery");
    const replacement = new ExecutionStreamProjector(db);
    await replacement.project(f.record(seed, 10n));
    await expect(replacement.project(f.record(f.seal, 30n))).rejects.toThrow("replay through");
    expect(
      (
        await db
          .selectFrom("session_leases")
          .select("writer_seal_offset")
          .where("lease_id", "=", f.seal.scope.writerId)
          .executeTakeFirstOrThrow()
      ).writer_seal_offset,
    ).toBeNull();
    await replacement.project(f.record(progress, 20n));
    await replacement.project(f.record(f.seal, 30n));
    await pg.assertComplete();
    const snapshot = await pg.revisions(100, 2);
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0]?.checkpoint).toEqual({
      generation: { attempt: 1, message: { text: "accepted live suffix" } },
    });
    expect((await pg.head()).seq).toBe(2);
    expect(await replacement.project(f.record(f.seal, 30n))).toMatchObject({
      terminal: { type: "turn.failed" },
    });
  });
  it("covers display only after its referenced native commit and retains immutable borrowed tails", async () => {
    const f = await fixture(),
      p = new ExecutionStreamProjector(db),
      view = new SessionLiveView(async () => {});
    try {
      for (let seq = 1; seq <= 100; seq++) {
        const fact = f.delta(seq, "hello ");
        await p.project(f.record(fact, BigInt(seq)));
        view.accept(tenantId, fact.event);
      }
      const borrowed = view.snapshot(tenantId, f.session.sessionId),
        native = f.mutation("hello ".repeat(100), "stop");
      await p.project(f.record(native, 101n));
      const checkpoint = { ...f.delta(101, ""), nativeSequence: native.commit.seq };
      const covered = await p.project(f.record(checkpoint, 102n));
      expect(covered?.canonicalThroughSequence).toBe(101);
      view.cover(tenantId, f.session.sessionId, 101);
      expect(view.statistics().cachedBytes).toBe(0);
      expect(borrowed.events[0]).toMatchObject({ payload: { text: "hello ".repeat(100) } });
      expect(
        (await readCanonicalPiTurnTranscripts(db, { tenantId, turnIds: [f.first.turnId] })).get(
          f.first.turnId,
        )?.items,
      ).toMatchObject([{ kind: "text", text: "hello ".repeat(100) }]);
    } finally {
      view.close();
    }
  });
  it("rejects late native writes at the PG boundary after a writer seal", async () => {
    const f = await fixture(),
      p = new ExecutionStreamProjector(db);
    const native = f.mutation("retained interrupted text", "aborted");
    await p.project(f.record(native, 10n));
    await p.project(f.record(f.delta(1, "retained interrupted text"), 11n));
    expect(await f.executor.dispatchRun(f.second.runId)).toEqual({ status: "idle" });
    const result = await p.project(f.record(f.seal, 12n));
    expect(result?.terminal?.seq).toBe(2);
    const late = f.mutation("must not enter history", "stop");
    await p.project(f.record(late, 13n));
    await new PostgresDurableCommitProjector(db).project(late, f.record(late, 13n));
    expect((await f.projection.head()).seq).toBe(1);
    const transcript = (
      await readCanonicalPiTurnTranscripts(db, { tenantId, turnIds: [f.first.turnId] })
    ).get(f.first.turnId)!;
    expect(transcript.items).toMatchObject([{ kind: "text", text: "retained interrupted text" }]);
    expect(JSON.stringify(transcript)).not.toContain("must not enter");
    expect((await f.executor.dispatchRun(f.second.runId)).status).toBe("failed");
  });
  it("replays a native prefix idempotently after consumer replacement", async () => {
    const f = await fixture(),
      record = f.record(f.mutation("complete native text", "aborted"), 20n),
      delta = f.record(f.delta(1, "complete native text"), 21n);
    const old = new ExecutionStreamProjector(db);
    await old.project(record);
    await old.project(delta);
    const fresh = new ExecutionStreamProjector(db);
    await fresh.project(record);
    await fresh.project(delta);
    await fresh.project(f.record(f.seal, 22n));
    expect((await f.projection.head()).seq).toBe(1);
    expect(
      (await readCanonicalPiTurnTranscripts(db, { tenantId, turnIds: [f.first.turnId] })).get(
        f.first.turnId,
      )?.items,
    ).toHaveLength(1);
  });
  it("rejects a native sequence hole without advancing projection progress", async () => {
    const f = await fixture(),
      fact = f.mutation("hole");
    const invalid = { ...fact, commit: { ...fact.commit, seq: 2 } };
    await expect(new ExecutionStreamProjector(db).project(f.record(invalid, 30n))).rejects.toThrow(
      "not contiguous",
    );
    expect((await f.projection.head()).seq).toBe(0);
  });
  it("rejects a display checkpoint that precedes native persistence", async () => {
    const f = await fixture();
    await expect(
      new ExecutionStreamProjector(db).project(
        f.record({ ...f.delta(1, "uncommitted"), nativeSequence: 99 }, 30n),
      ),
    ).rejects.toThrow("preceded its native commit");
  });
  it("reloads durable closure after an assignment reset", async () => {
    const f = await fixture(),
      p = new ExecutionStreamProjector(db);
    await p.project(f.record(f.seal, 40n));
    expect(
      await new ExecutionStreamBoundary(db).isOpen(f.record(f.delta(2, "late"), 41n), false),
    ).toBe(false);
  });
  it("fails closed if retention removed an unsealed prefix", async () => {
    const f = await fixture();
    await new ExecutionStreamProjector(db).project(f.record(f.delta(1, "prefix"), 50n));
    await expect(new ExecutionStreamProjector(db).project(f.record(f.seal, 60n))).rejects.toThrow(
      "prefix is missing",
    );
    expect(
      (await loadFactReplayOffsets(db, "seals-test", [{ partition: 0, low: 51n, high: 61n }])).get(
        0,
      ),
    ).toBeInstanceOf(Error);
  });
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
        async listTopics() {
          return [];
        },
        async deleteTopics() {},
        async listGroups() {
          return new Map();
        },
        async deleteGroups() {},
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
        .selectFrom("runs")
        .select("output_sealed_at")
        .where("id", "=", f.seal.scope.runId)
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
    expect(await restored.project(seal)).toMatchObject({ terminal: { type: "turn.failed" } });
  });

  it("returns the committed terminal directly and never appends another commit notification", async () => {
    const f = await fixture(),
      projector = new ExecutionStreamProjector(db);
    const first = await projector.project(f.record(f.seal, 20n));
    const repeated = await new ExecutionStreamProjector(db).project(f.record(f.seal, 21n));
    expect(repeated).toEqual(first);
    expect(first).toMatchObject({ terminal: { type: "turn.failed" } });
    const rows = await db
      .selectFrom("outbox")
      .select("payload")
      .where("tenant_id", "=", tenantId)
      .execute();
    expect(rows.some((r) => r.payload.kind === "execution_committed")).toBe(false);
  });
});
