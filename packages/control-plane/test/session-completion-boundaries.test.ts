// Regression contracts for ADR-0256; PostgreSQL transactions are real.
import { afterEach, expect, it } from "vitest";
import { nativeSubagentFixture } from "./native-subagent-fixture.ts";
import { ExecutionStreamProjector } from "../../runtime-core/src/execution-stream-projection.ts";
import { SessionLiveView } from "../../runtime-core/src/session-live-view.ts";
import type { AcceptedWorkFinishedFact } from "../../runtime-core/src/accepted-fact.ts";
import { requestExecutionStreamSeal } from "../../runtime-core/src/execution-stream-seal.ts";
import type { AcceptedExecutionSealFact } from "../../runtime-core/src/accepted-fact.ts";
import { createTestWorker } from "./admit-test-execution.ts";

const resources: Array<Awaited<ReturnType<typeof nativeSubagentFixture>>> = [];
afterEach(async () => {
  for (const f of resources.splice(0)) await f.close();
});

it("redelivers the persisted terminal after a lost completion transaction return", async () => {
  const f = await nativeSubagentFixture();
  resources.push(f);
  let loseCommit = true;
  // The actual PG transaction commits. Only its return to the caller is lost.
  const database = new Proxy(f.database, {
    get(target, key) {
      if (key === "transaction")
        return () => {
          const builder = target.transaction();
          return new Proxy(builder, {
            get(transaction, property) {
              if (property === "execute")
                return async (work: Parameters<typeof builder.execute>[0]) => {
                  const result = await transaction.execute(work);
                  if (loseCommit) {
                    loseCommit = false;
                    throw new Error("Injected COMMIT response loss after actual PG commit");
                  }
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
  const projector = new ExecutionStreamProjector(database);
  const live = new SessionLiveView(async () => {});
  const fact: AcceptedWorkFinishedFact = {
    kind: "work_finished",
    factId: crypto.randomUUID(),
    scope: f.scope,
    agentId: "root",
    baseSequence: 1,
    nativeSequence: 1,
    terminal: { type: "turn.completed", payload: { stopReason: "stop" } },
    occurredAt: new Date().toISOString(),
  };
  live.accept(f.scope.tenantId, {
    schemaVersion: 1,
    eventId: crypto.randomUUID(),
    sessionId: f.scope.sessionId,
    turnId: f.scope.turnId,
    agentId: "root",
    seq: 1,
    occurredAt: fact.occurredAt,
    type: "turn.started",
    payload: { inputKind: "prompt" },
  });
  const record = { fact, topic: "review-normal-finish", partition: 0, offset: 1n };
  try {
    await expect(projector.project(record)).rejects.toThrow("COMMIT response loss");
    const persisted = await f.database
      .selectFrom("session_terminal_events")
      .select(["event_id", "seq", "type"])
      .where("run_id", "=", f.scope.runId)
      .execute();
    expect(persisted).toEqual([{ event_id: fact.factId, seq: "2", type: "turn.completed" }]);
    const replay = await projector.project(record);
    if (replay?.terminal) live.accept(f.scope.tenantId, replay.terminal);
    expect(replay?.terminal).toMatchObject({
      eventId: fact.factId,
      seq: 2,
      type: "turn.completed",
    });
    expect(replay?.canonicalThroughSequence).toBe(2);
    expect(live.snapshot(f.scope.tenantId, f.scope.sessionId).highWaterMark).toBe(2);
    expect(live.statistics().cachedEvents).toBe(0);
    const repeated = await projector.project(record);
    expect(repeated).toEqual(replay);
    live.accept(f.scope.tenantId, repeated!.terminal!);
    expect(live.statistics().acceptedEvents).toBe(2);
    expect(live.statistics().duplicateEvents).toBe(1);
    expect(
      await f.database
        .selectFrom("session_terminal_events")
        .select("event_id")
        .where("run_id", "=", f.scope.runId)
        .execute(),
    ).toHaveLength(1);
  } finally {
    live.close();
  }
}, 30000);

it("carries the updated Run version through native cancellation and replays one terminal", async () => {
  const f = await nativeSubagentFixture();
  resources.push(f);
  const before = await f.database
    .selectFrom("runs")
    .select("row_version")
    .where("id", "=", f.scope.runId)
    .executeTakeFirstOrThrow();
  const projector = new ExecutionStreamProjector(f.database);
  const record = {
    topic: "native-cancel-finish",
    partition: 0,
    offset: 1n,
    fact: {
      kind: "work_finished" as const,
      factId: crypto.randomUUID(),
      scope: f.scope,
      agentId: "root",
      baseSequence: 0,
      nativeSequence: 1,
      occurredAt: new Date().toISOString(),
      terminal: {
        type: "turn.cancelled" as const,
        payload: { reason: "user_request" as const, forced: false },
      },
    },
  };
  const first = await projector.project(record);
  expect(first?.terminal?.type).toBe("turn.cancelled");
  const after = await f.database
    .selectFrom("runs")
    .select(["row_version", "state"])
    .where("id", "=", f.scope.runId)
    .executeTakeFirstOrThrow();
  expect(after.state).toBe("cancelled");
  expect(BigInt(after.row_version)).toBe(BigInt(before.row_version) + 2n);
  const transitions = await f.database
    .selectFrom("run_transitions")
    .select(["from_state", "to_state"])
    .where("run_id", "=", f.scope.runId)
    .execute();
  expect(transitions).toEqual(
    expect.arrayContaining([
      { from_state: "running", to_state: "cancel_requested" },
      { from_state: "cancel_requested", to_state: "cancelled" },
    ]),
  );
  expect(await projector.project(record)).toEqual(first);
  expect(
    await f.database
      .selectFrom("runs")
      .select(["row_version", "state"])
      .where("id", "=", f.scope.runId)
      .executeTakeFirstOrThrow(),
  ).toEqual(after);
}, 30000);

it("ignores late completion from a closed writer after the same Run is readmitted", async () => {
  const f = await nativeSubagentFixture();
  resources.push(f);
  const projector = new ExecutionStreamProjector(f.database),
    sealId = crypto.randomUUID();
  await f.database.transaction().execute((tx) =>
    requestExecutionStreamSeal(tx, {
      ...f.scope,
      agentId: "root",
      recover: true,
      now: new Date(),
      eventId: sealId,
    }),
  );
  const row = await f.database
    .selectFrom("outbox")
    .select("payload")
    .where("id", "=", sealId)
    .executeTakeFirstOrThrow();
  await projector.project({
    fact: row.payload as unknown as AcceptedExecutionSealFact,
    topic: "late-finish",
    partition: 0,
    offset: 1n,
  });
  await f.database
    .updateTable("environment_versions")
    .set({ state: "validated", validated_at: new Date() })
    .where("id", "=", f.project.environment.environmentVersionId)
    .execute();
  const worker = await createTestWorker(f.database),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const work = worker
    .executor({
      execute: async () => {
        entered.resolve();
        await release.promise;
        return { stopReason: "stop" };
      },
    })
    .dispatchRun(f.scope.runId);
  void work.catch(entered.reject);
  try {
    await entered.promise;
    const current = await f.database
      .selectFrom("runs")
      .select(["lease_id", "state", "row_version"])
      .where("id", "=", f.scope.runId)
      .executeTakeFirstOrThrow();
    expect(current.lease_id).not.toBe(f.scope.writerId);
    const stale = await projector.project({
      topic: "late-finish",
      partition: 0,
      offset: 2n,
      fact: {
        kind: "work_finished",
        factId: crypto.randomUUID(),
        scope: f.scope,
        agentId: "root",
        baseSequence: 0,
        nativeSequence: 1,
        occurredAt: new Date().toISOString(),
        terminal: { type: "turn.completed", payload: { stopReason: "stop" } },
      },
    });
    expect(stale).toBeUndefined();
    expect(
      await f.database
        .selectFrom("runs")
        .select(["lease_id", "state", "row_version"])
        .where("id", "=", f.scope.runId)
        .executeTakeFirstOrThrow(),
    ).toEqual(current);
    expect(
      await f.database
        .selectFrom("session_terminal_events")
        .select("event_id")
        .where("run_id", "=", f.scope.runId)
        .execute(),
    ).toHaveLength(0);
  } finally {
    release.resolve();
    await work;
  }
}, 30000);

it("uses one locked Run read for normal completion", async () => {
  const f = await nativeSubagentFixture();
  resources.push(f);
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
  await projector.project({
    topic: "review-normal-finish",
    partition: 0,
    offset: 1n,
    fact: {
      kind: "durable_commit",
      factId: crypto.randomUUID(),
      scope: f.scope,
      commit: {
        seq: 2,
        nextId: 3,
        writes: [
          { type: "entry", value: { id: 2, conversationId: 1, kind: "review", data: "done" } },
        ],
      },
      origins: [
        { recordId: 2, sessionId: f.scope.sessionId, runId: f.scope.runId, turnId: f.scope.turnId },
      ],
      tools: [],
      cancellations: [],
      display: [],
      occurredAt: new Date().toISOString(),
    },
  });
  queries.length = 0;
  const result = await projector.project({
    topic: "review-normal-finish",
    partition: 0,
    offset: 2n,
    fact: {
      kind: "work_finished",
      factId: crypto.randomUUID(),
      scope: f.scope,
      agentId: "root",
      baseSequence: 0,
      nativeSequence: 2,
      terminal: { type: "turn.completed", payload: { stopReason: "stop" } },
      occurredAt: new Date().toISOString(),
    },
  });
  expect(result?.terminal?.type).toBe("turn.completed");
  const runReads = queries.filter(
    (query) => /^select\b/.test(query) && query.includes('from "runs"'),
  );
  expect(runReads).toHaveLength(1);
  // Includes one immutable presentation header/root; Run authority is still read once.
  expect(queries.length).toBeLessThanOrEqual(27);
  process.stdout.write(
    JSON.stringify({
      measurement: "normal_finish_sql",
      totalStatements: queries.length,
      runReads: runReads.length,
    }) + "\n",
  );
}, 30000);
