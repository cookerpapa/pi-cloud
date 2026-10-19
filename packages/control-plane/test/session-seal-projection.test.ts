// ADR-0261: real PG closure, replay, resource lifetime and admission contracts.
import { afterEach, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import { createDatabase, type Database } from "@pi-cloud/database";
import { DurablePostgresProjection } from "@pi-cloud/pi-session-postgres/durable";
import { nativeSubagentFixture } from "./native-subagent-fixture.ts";
import { createTestWorker } from "./admit-test-execution.ts";
import { ExecutionStreamProjector } from "../../runtime-core/src/execution-stream-projection.ts";
import { requestExecutionStreamSeal } from "../../runtime-core/src/execution-stream-seal.ts";
import type {
  AcceptedDurableCommitFact,
  AcceptedExecutionSealFact,
} from "../../runtime-core/src/accepted-fact.ts";
import { PostgresDurableCommitProjector } from "../../runtime-core/src/postgres-durable-commit-projector.ts";
import { projectionTransaction } from "../../runtime-core/src/projection-transaction.ts";
import { transitionCurrentRun } from "../../runtime-core/src/run-state.ts";

const resources: Array<Awaited<ReturnType<typeof nativeSubagentFixture>>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of resources.splice(0)) await fixture.close();
});

async function fixture() {
  const f = await nativeSubagentFixture();
  resources.push(f);
  return f;
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const topic = "review-seal-projection";
const record = (fact: AcceptedDurableCommitFact | AcceptedExecutionSealFact, offset: bigint) => ({
  fact,
  topic,
  partition: 0,
  offset,
});
function liveFacts(f: Fixture, text = "accepted partial") {
  const fact = (seq: number, writes: Record<string, unknown>[]): AcceptedDurableCommitFact => ({
    kind: "durable_commit",
    factId: crypto.randomUUID(),
    scope: f.scope,
    occurredAt: new Date().toISOString(),
    commit: { seq, nextId: 3, writes },
    origins: [],
    tools: [],
    cancellations: [],
    display: [],
  });
  return [
    fact(2, [
      {
        type: "document.create",
        record: {
          id: 2,
          kind: "pi.live",
          scope: { kind: "conversation", conversationId: 1 },
          history: "latest",
          fork: "initial",
        },
        content: { kind: "base", version: 1, value: {} },
      },
    ]),
    fact(3, [
      {
        type: "document.change",
        id: 2,
        content: {
          kind: "delta",
          version: 1,
          ops: [["s", ["generation"], { attempt: 1, message: { text } }]],
        },
      },
    ]),
  ] as const;
}
async function request(f: Fixture, recover = true) {
  const id = crypto.randomUUID();
  await f.database.transaction().execute(async (tx) => {
    if (!recover)
      await transitionCurrentRun(
        tx,
        { tenantId: f.scope.tenantId, runId: f.scope.runId },
        {
          runState: "failed",
          reason: "fixture_terminal",
          now: new Date(),
          failure: { code: "fixture_failure", message: "Terminal fixture", retryable: false },
        },
      );
    await requestExecutionStreamSeal(tx, {
      ...f.scope,
      eventId: id,
      agentId: "root",
      now: new Date(),
      ...(recover
        ? { recover: true as const }
        : {
            body: {
              type: "turn.failed" as const,
              payload: { code: "fixture_failure", message: "Terminal fixture", retryable: false },
            },
          }),
    });
  });
  const row = await f.database
    .selectFrom("outbox")
    .select("payload")
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
  return row.payload as unknown as AcceptedExecutionSealFact;
}
async function state(f: Fixture) {
  const { rows } = await sql<{
    state: string;
    lease: string | null;
    released: boolean;
    sealed: boolean;
    pending: number;
    seq: string;
  }>`select r.state, r.lease_id::text as lease, l.released_at is not null as released,
    l.writer_sealed_at is not null as sealed,
    (select count(*)::int from pi_durable_current c where c.tenant_id=r.tenant_id
      and c.session_id=${f.scope.piSessionId} and c.replay_offset is not null) as pending,
    (select max(seq)::text from pi_durable_commits c where c.tenant_id=r.tenant_id
      and c.session_id=${f.scope.piSessionId}) as seq
    from runs r join session_leases l on l.lease_id=${f.scope.writerId}::uuid
    where r.id=${f.scope.runId}::uuid`.execute(f.database);
  return rows[0]!;
}
function loseTransactionReturn(database: Kysely<Database>, shouldLose: () => boolean) {
  return new Proxy(database, {
    get(target, key) {
      if (key === "transaction")
        return () => {
          const builder = target.transaction();
          return new Proxy(builder, {
            get(transaction, property) {
              if (property === "execute")
                return async (work: Parameters<typeof builder.execute>[0]) => {
                  const result = await transaction.execute(work);
                  if (shouldLose()) throw new Error("review: actual PG COMMIT return lost");
                  return result;
                };
              const value = Reflect.get(transaction, property, transaction);
              return typeof value === "function" ? value.bind(transaction) : value;
            },
          });
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

it("rolls back checkpoint, closure and readiness together; replay can then finish", async () => {
  const f = await fixture();
  let fail = false;
  const queries = new Map<object, string>();
  const database = f.database.withPlugin({
    transformQuery({ node, queryId }) {
      queries.set(queryId, f.database.getExecutor().compileQuery(node, queryId).sql);
      return node;
    },
    async transformResult({ result, queryId }) {
      const query = queries.get(queryId) ?? "";
      queries.delete(queryId);
      if (
        fail &&
        query.startsWith('update "session_leases"') &&
        query.includes('"writer_sealed_at"')
      ) {
        fail = false;
        throw new Error("review: rollback after checkpoint and closure SQL");
      }
      return result;
    },
  });
  const projector = new ExecutionStreamProjector(database);
  const [seed, progress] = liveFacts(f);
  await projector.project(record(seed, 10n));
  await projector.project(record(progress, 20n));
  const seal = record(await request(f), 30n);
  fail = true;
  await expect(projector.project(seal)).rejects.toThrow("rollback after checkpoint");
  expect(await state(f)).toEqual({
    state: "running",
    lease: f.scope.writerId,
    released: false,
    sealed: false,
    pending: 1,
    seq: "3",
  });
  await expect(f.projection.assertComplete()).rejects.toThrow("Kafka recovery");
  await projector.project(seal);
  expect(await state(f)).toEqual({
    state: "queued",
    lease: null,
    released: true,
    sealed: true,
    pending: 0,
    seq: "3",
  });
  expect((await f.projection.revisions(2, 3))[0]?.checkpoint).toEqual({
    generation: { attempt: 1, message: { text: "accepted partial" } },
  });
}, 30000);

it.each([true, false])(
  "reconciles a lost seal COMMIT return and retires the old live cache (recover=%s)",
  async (recover) => {
    const f = await fixture();
    let lose = false;
    const database = loseTransactionReturn(f.database, () => {
      if (!lose) return false;
      lose = false;
      return true;
    });
    let firstView: DurablePostgresProjection | undefined;
    const originalApply = DurablePostgresProjection.prototype.applyIn;
    vi.spyOn(DurablePostgresProjection.prototype, "applyIn").mockImplementation(function (
      this: DurablePostgresProjection,
      ...args
    ) {
      firstView ??= this;
      return originalApply.apply(this, args);
    });
    const projector = new ExecutionStreamProjector(database);
    const text = "x".repeat(1024 * 1024);
    const [seed, progress] = liveFacts(f, text);
    await projector.project(record(seed, 10n));
    await projector.project(record(progress, 20n));
    const seal = record(await request(f, recover), 30n);
    lose = true;
    await expect(projector.project(seal)).rejects.toThrow("COMMIT return lost");
    expect(await state(f)).toEqual({
      state: recover ? "queued" : "failed",
      lease: recover ? null : f.scope.writerId,
      released: true,
      sealed: true,
      pending: 0,
      seq: "3",
    });
    const replay = await projector.project(seal);
    expect(await projector.project(seal)).toEqual(replay);
    if (!recover) expect(replay?.terminal?.type).toBe("turn.failed");
    await f.projection.assertComplete();
    expect((await f.projection.revisions(2, 3))[0]?.checkpoint).toEqual({
      generation: { attempt: 1, message: { text } },
    });

    // Ordinary read-only replay must create an empty view instead of reaching
    // the old cached body. No private-field access or heap snapshot is needed.
    let replayView: DurablePostgresProjection | undefined;
    const originalReplay = DurablePostgresProjection.prototype.replayLiveIn;
    vi.spyOn(DurablePostgresProjection.prototype, "replayLiveIn").mockImplementation(function (
      this: DurablePostgresProjection,
      ...args
    ) {
      replayView = this;
      return originalReplay.apply(this, args);
    });
    await projector.project(record(seed, 10n));
    expect(replayView).not.toBe(firstView);
    const retainedBytes = [...replayView!.liveState.rows.values()].reduce(
      (n, row) => n + Buffer.byteLength(row.body),
      0,
    );
    expect(retainedBytes).toBe(0);
    expect(projector.statistics()).toEqual({ prefixes: 0, pendingEventIds: 0 });
    process.stdout.write(
      JSON.stringify({
        measurement: "seal_lost_commit_return",
        recover,
        exactPgCheckpoint: true,
        oldLeaseReleased: true,
        duplicateSealAccepted: true,
        retainedLiveRows: replayView!.liveState.rows.size,
        retainedBodyBytes: retainedBytes,
      }) + "\n",
    );
    projector.reset();
    await projector.project(record(seed, 10n));
    expect(replayView).not.toBe(firstView);
    expect(replayView!.liveState.rows.size).toBe(0);
  },
  30000,
);

it("does not admit a successor before closure COMMIT and ignores the old seal after a new grant", async () => {
  const f = await fixture();
  await f.database
    .updateTable("environment_versions")
    .set({ state: "validated", validated_at: new Date() })
    .where("id", "=", f.project.environment.environmentVersionId)
    .execute();
  const paused = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let hold = false;
  const database = new Proxy(f.database, {
    get(target, key) {
      if (key === "transaction")
        return () => {
          const builder = target.transaction();
          return new Proxy(builder, {
            get(transaction, property) {
              if (property === "execute")
                return (work: Parameters<typeof builder.execute>[0]) =>
                  transaction.execute(async (tx) => {
                    const result = await work(tx);
                    if (hold) {
                      hold = false;
                      paused.resolve();
                      await release.promise;
                    }
                    return result;
                  });
              const value = Reflect.get(transaction, property, transaction);
              return typeof value === "function" ? value.bind(transaction) : value;
            },
          });
        };
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const projector = new ExecutionStreamProjector(database);
  const [seed, progress] = liveFacts(f);
  await projector.project(record(seed, 10n));
  await projector.project(record(progress, 20n));
  const seal = record(await request(f), 30n);
  const worker = await createTestWorker(f.database);
  const started = Promise.withResolvers<void>();
  const finish = Promise.withResolvers<void>();
  const executor = worker.executor({
    execute: async () => {
      await f.projection.assertComplete();
      started.resolve();
      await finish.promise;
      return { stopReason: "stop", lastEventSeq: 0 };
    },
  });
  hold = true;
  const sealing = projector.project(seal);
  void sealing.catch(paused.reject);
  let running: Promise<unknown> | undefined;
  try {
    await paused.promise;
    expect(await executor.dispatchRun(f.scope.runId)).toEqual({ status: "idle" });
    expect((await state(f)).pending).toBe(1);
    release.resolve();
    await sealing;
    running = executor.dispatchRun(f.scope.runId);
    await started.promise;
    const before = await f.database
      .selectFrom("runs")
      .select(["lease_id", "fencing_token", "state"])
      .where("id", "=", f.scope.runId)
      .executeTakeFirstOrThrow();
    expect(before.lease_id).not.toBe(f.scope.writerId);
    expect(Number(before.fencing_token)).toBe(2);
    const next = {
      ...progress,
      scope: { ...f.scope, writerId: before.lease_id!, fencingToken: Number(before.fencing_token) },
      commit: { ...progress.commit, seq: 4 },
    };
    await projector.project(record(next, 40n));
    await projector.project(seal);
    // Historical prefix reconstruction and old closure cannot discard the new
    // writer's unapplied-to-PG suffix; its next delta requires that exact memory.
    await projector.project(record(seed, 10n));
    await projector.project(seal);
    await projector.project(
      record(
        {
          ...next,
          factId: crypto.randomUUID(),
          commit: {
            ...next.commit,
            seq: 5,
            writes: [
              {
                type: "document.change",
                id: 2,
                content: {
                  kind: "delta",
                  version: 1,
                  ops: [["a", ["generation", "message", "text"], " continued"]],
                },
              },
            ],
          },
        },
        50n,
      ),
    );
    await projector.project(
      record(
        {
          ...next,
          factId: crypto.randomUUID(),
          commit: {
            ...next.commit,
            seq: 6,
            writes: [
              {
                type: "document.change",
                id: 2,
                content: {
                  kind: "base",
                  version: 1,
                  value: {},
                },
              },
            ],
          },
        },
        60n,
      ),
    );
    expect(
      await f.database
        .selectFrom("runs")
        .select(["lease_id", "fencing_token", "state"])
        .where("id", "=", f.scope.runId)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
  } finally {
    release.resolve();
    await sealing;
    finish.resolve();
    await running;
  }
}, 30000);

it("reuses the locked Run during recovery with nineteen business SQL statements", async () => {
  const f = await fixture();
  const queries: string[] = [];
  const database = f.database.withPlugin({
    transformQuery({ node, queryId }) {
      queries.push(f.database.getExecutor().compileQuery(node, queryId).sql);
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  const projector = new ExecutionStreamProjector(database);
  const [seed, progress] = liveFacts(f);
  await projector.project(record(seed, 10n));
  await projector.project(record(progress, 20n));
  const seal = record(await request(f), 30n);
  queries.length = 0;
  await projector.project(seal);
  const reads = queries.filter((q) => /^select\b/.test(q) && q.includes('from "runs"'));
  expect(reads).toHaveLength(1);
  expect(queries).toHaveLength(20);
  process.stdout.write(
    JSON.stringify({
      measurement: "recovery_seal_sql",
      statements: queries.length,
      runReads: reads.length,
      businessStatements: queries.length - 1,
      queries,
    }) + "\n",
  );
}, 30000);

it("bounds acquisition even while the previous checkout caller remains held", async () => {
  const f = await fixture();
  const database = createDatabase({
    connectionString: f.url,
    maxConnections: 1,
    checkoutTimeoutMs: 150,
  });
  const held = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const holder = database.connection().execute(async () => {
    held.resolve();
    await release.promise;
  });
  void holder.catch(held.reject);
  let settled = false;
  let operation: Promise<unknown> | undefined;
  try {
    await held.promise;
    const start = performance.now();
    operation = projectionTransaction(
      database,
      async (tx) => {
        await sql`select 1`.execute(tx);
      },
      { lockTimeoutMs: 20, statementTimeoutMs: 60 },
    )
      .catch((error: Error) => {
        expect(error.message).toMatch(/timeout|expired|terminated|closed/i);
      })
      .finally(() => {
        settled = true;
      });
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 2000 });
    await operation;
    await expect(sql`select 1`.execute(database)).resolves.toBeDefined();
    process.stdout.write(
      JSON.stringify({
        measurement: "projection_pool_wait",
        checkoutMs: 150,
        observationMs: performance.now() - start,
        settled,
      }) + "\n",
    );
  } finally {
    release.resolve();
    await holder;
    await operation;
    await database.destroy();
  }
}, 30000);

it.each(["cold boundary", "seal transaction"])(
  "bounds a locked %s and preserves closure for retry",
  async (phase) => {
    const f = await fixture();
    const database = createDatabase({
      connectionString: f.url,
      maxConnections: 1,
      checkoutTimeoutMs: 500,
    });
    const projector = new ExecutionStreamProjector(database);
    const [seed, progress] = liveFacts(f);
    await projector.project(record(seed, 10n));
    await projector.project(record(progress, 20n));
    const seal = record(await request(f), 30n);
    if (phase === "cold boundary") projector.reset();
    const held = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const holder = f.database.transaction().execute(async (tx) => {
      await sql`set local idle_in_transaction_session_timeout='10s'`.execute(tx);
      if (phase === "cold boundary")
        await sql`lock table runs in access exclusive mode`.execute(tx);
      else
        await tx
          .selectFrom("runs")
          .select("id")
          .where("id", "=", f.scope.runId)
          .forNoKeyUpdate()
          .execute();
      held.resolve();
      await release.promise;
    });
    void holder.catch(held.reject);
    try {
      await held.promise;
      const failure = projector.project(phase === "cold boundary" ? record(seed, 10n) : seal);
      await expect(failure).rejects.toBeInstanceOf(Error);
      release.resolve();
      await holder;
      expect(await state(f)).toMatchObject({ released: false, sealed: false, pending: 1 });
      await projector.project(record(seed, 10n));
      await projector.project(record(progress, 20n));
      await projector.project(seal);
      expect(await state(f)).toMatchObject({ released: true, sealed: true, pending: 0 });
    } finally {
      release.resolve();
      await holder;
      await database.destroy();
    }
  },
  30000,
);

it("does not let a delayed cleanup callback remove a replacement projection object", async () => {
  const f = await fixture(),
    projector = new PostgresDurableCommitProjector(f.database);
  const [seed, progress] = liveFacts(f);
  await projector.project(seed, record(seed, 10n));
  await projector.project(progress, record(progress, 20n));
  const cleanup = await f.database
    .transaction()
    .execute((tx) => projector.checkpointLiveIn(tx, f.scope, () => true));
  projector.reset();
  const next = { ...progress, factId: crypto.randomUUID(), commit: { ...progress.commit, seq: 4 } };
  await projector.project(next, record(next, 40n));
  cleanup();
  const last = { ...progress, factId: crypto.randomUUID(), commit: { ...progress.commit, seq: 5 } };
  await expect(projector.project(last, record(last, 50n))).resolves.toBeDefined();
}, 30000);
