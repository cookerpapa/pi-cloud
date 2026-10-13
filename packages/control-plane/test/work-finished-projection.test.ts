import { afterEach, expect, it } from "vitest";
import { nativeSubagentFixture } from "./native-subagent-fixture.ts";
import { ExecutionStreamProjector } from "../../runtime-core/src/execution-stream-projection.ts";
import { requestExecutionStreamSeal } from "../../runtime-core/src/execution-stream-seal.ts";
import type {
  AcceptedWorkFinishedFact,
  AcceptedExecutionSealFact,
} from "../../runtime-core/src/accepted-fact.ts";

const resources: Array<Awaited<ReturnType<typeof nativeSubagentFixture>>> = [];
afterEach(async () => {
  for (const f of resources.splice(0)) await f.close();
});
async function fixture() {
  const f = await nativeSubagentFixture();
  resources.push(f);
  const fact: AcceptedWorkFinishedFact = {
    kind: "work_finished",
    factId: crypto.randomUUID(),
    scope: f.scope,
    agentId: "root",
    baseSequence: 0,
    nativeSequence: 1,
    terminal: { type: "turn.completed", payload: { stopReason: "stop" } },
    retireWriter: true,
    occurredAt: new Date().toISOString(),
  };
  const projector = new ExecutionStreamProjector(f.database);
  return {
    ...f,
    fact,
    projector,
    project: (value: AcceptedWorkFinishedFact | AcceptedExecutionSealFact, offset: bigint) =>
      projector.project({ fact: value, topic: "finish-contract", partition: 0, offset }),
  };
}

it("materializes normal completion and owner retirement without a terminal Outbox hop", async () => {
  const f = await fixture();
  expect(
    (
      await f.database
        .selectFrom("runs")
        .select("state")
        .where("id", "=", f.scope.runId)
        .executeTakeFirstOrThrow()
    ).state,
  ).toBe("running");
  const done = await f.project(f.fact, 1n);
  expect(done?.terminal).toMatchObject({ type: "turn.completed", seq: 1 });
  expect(
    await f.database
      .selectFrom("runs")
      .select(["state", "output_seal_id", "output_seal_offset"])
      .where("id", "=", f.scope.runId)
      .executeTakeFirstOrThrow(),
  ).toMatchObject({ state: "completed", output_seal_id: null, output_seal_offset: "1" });
  const writer = await f.database
    .selectFrom("session_leases")
    .selectAll()
    .where("lease_id", "=", f.scope.writerId)
    .executeTakeFirstOrThrow();
  expect(writer.writer_seal_offset).toBe("1");
  expect(writer.released_at).not.toBeNull();
  expect(
    await f.database
      .selectFrom("outbox")
      .select("id")
      .where("aggregate_type", "=", "session_terminal_event")
      .execute(),
  ).toEqual([]);
  await f.project(f.fact, 1n);
  expect(
    await f.database.selectFrom("session_terminal_events").select("event_id").execute(),
  ).toHaveLength(1);
}, 30_000);

it("keeps a requested writer closure until its seal and never requeues a completed Run", async () => {
  const f = await fixture(),
    sealId = crypto.randomUUID();
  await f.database.transaction().execute((tx) =>
    requestExecutionStreamSeal(tx, {
      tenantId: f.scope.tenantId,
      sessionId: f.scope.sessionId,
      turnId: f.scope.turnId,
      runId: f.scope.runId,
      agentId: "root",
      recover: true,
      now: new Date(),
      eventId: sealId,
    }),
  );
  await f.project(f.fact, 1n);
  let writer = await f.database
    .selectFrom("session_leases")
    .selectAll()
    .where("lease_id", "=", f.scope.writerId)
    .executeTakeFirstOrThrow();
  expect(writer.writer_seal_offset).toBeNull();
  expect(writer.released_at).toBeNull();
  const seal = await f.database
    .selectFrom("outbox")
    .select("payload")
    .where("id", "=", sealId)
    .executeTakeFirstOrThrow();
  await f.project(seal.payload as unknown as AcceptedExecutionSealFact, 2n);
  writer = await f.database
    .selectFrom("session_leases")
    .selectAll()
    .where("lease_id", "=", f.scope.writerId)
    .executeTakeFirstOrThrow();
  expect(writer.writer_seal_offset).toBe("2");
  expect(writer.released_at).not.toBeNull();
  expect(
    (
      await f.database
        .selectFrom("runs")
        .select("state")
        .where("id", "=", f.scope.runId)
        .executeTakeFirstOrThrow()
    ).state,
  ).toBe("completed");
  expect(
    await f.database.selectFrom("session_terminal_events").select("event_id").execute(),
  ).toHaveLength(1);
}, 30_000);

it("does not finalize ahead of its last native commit", async () => {
  const f = await fixture();
  await expect(f.project({ ...f.fact, nativeSequence: 2 }, 1n)).rejects.toThrow(
    "final native commit",
  );
  expect(
    (
      await f.database
        .selectFrom("runs")
        .select("state")
        .where("id", "=", f.scope.runId)
        .executeTakeFirstOrThrow()
    ).state,
  ).toBe("running");
}, 30_000);
