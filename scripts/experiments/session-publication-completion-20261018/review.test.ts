// Review characterizations of the 2026-10-18 baseline, not repaired behavior.
import { afterEach, expect, it } from "vitest";
import { nativeSubagentFixture } from "../../../packages/control-plane/test/native-subagent-fixture.ts";
import { ExecutionStreamProjector } from "../../../packages/runtime-core/src/execution-stream-projection.ts";
import { SessionLiveView } from "../../../packages/runtime-core/src/session-live-view.ts";
import type { AcceptedWorkFinishedFact } from "../../../packages/runtime-core/src/accepted-fact.ts";
import { PostgresDurableSessionHost } from "@pi-cloud/pi-session-postgres/durable";
import { PublicationNotSentError } from "@pi-cloud/protocol";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";

const resources: Array<Awaited<ReturnType<typeof nativeSubagentFixture>>> = [];
afterEach(async () => {
  for (const f of resources.splice(0)) await f.close();
});

it("characterizes a committed normal finish whose transaction response is lost", async () => {
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
    // Existing behavior: retry succeeds but never supplies the stored terminal.
    expect(replay?.terminal).toBeUndefined();
    expect(live.snapshot(f.scope.tenantId, f.scope.sessionId).highWaterMark).toBe(1);
    expect(live.statistics().cachedEvents).toBe(1);
  } finally {
    live.close();
  }
}, 30000);

it("characterizes a proved pre-send rejection retiring the shared native owner", async () => {
  const f = await nativeSubagentFixture();
  resources.push(f);
  const host = new PostgresDurableSessionHost({ database: f.database });
  let publishes = 0;
  const handle = await host.open({
    binding: {
      ...f.scope,
      conversationId: 1,
      executionReference: f.reference,
    },
    publish: async () => {
      publishes++;
      if (publishes === 1) throw new PublicationNotSentError("Injected local queue refusal");
    },
  });
  try {
    const head = handle.committedSequence();
    const writes = [
      {
        type: "entry" as const,
        value: { id: 2 as never, conversationId: 1 as never, kind: "review", data: "not sent" },
      },
    ];
    await expect(handle.storage.commit(writes, BACKGROUND_CONTEXT)).rejects.toMatchObject({
      name: "StorageRejected",
    });
    expect(handle.committedSequence()).toBe(head);
    expect((await f.projection.head()).seq).toBe(head);
    // The Storage port knows no append was submitted, but its outer owner is poisoned.
    expect(handle.authority.signal.aborted).toBe(true);
    expect(handle.authority.signal.reason).toMatchObject({ code: "writer_publication_failed" });
    await expect(handle.storage.commit(writes, BACKGROUND_CONTEXT)).rejects.toThrow(
      "Native Session publication failed",
    );
    expect(publishes).toBe(1);
  } finally {
    await host.close();
  }
}, 30000);

it("measures normal completion rereading its already locked Run", async () => {
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
  expect(runReads).toHaveLength(3);
  process.stdout.write(
    JSON.stringify({
      measurement: "normal_finish_sql",
      totalStatements: queries.length,
      runReads: runReads.length,
      queries,
    }) + "\n",
  );
}, 30000);
