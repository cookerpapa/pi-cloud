import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { nativeSubagentFixture } from "../../../packages/control-plane/test/native-subagent-fixture.ts";
import { SubagentController } from "../../../packages/control-plane/src/subagent-controller.ts";
import {
  ControlToolDispatcher,
  type ControlToolOutcome,
} from "../../../packages/control-plane/src/control-tool-dispatcher.ts";
import { prepareSubagentArguments } from "../../../packages/protocol/src/control-tools.ts";
import type { AcceptedDurableCommitFact } from "../../../packages/runtime-core/src/accepted-fact.ts";
import type { StoredDurableBatch } from "../../../packages/pi-session-postgres/src/durable/types.ts";

let f: Awaited<ReturnType<typeof nativeSubagentFixture>>;
let host: SubagentController;
beforeAll(async () => {
  if (!process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL)
    throw new Error("Use the isolated PG wrapper");
  f = await nativeSubagentFixture();
  host = new SubagentController({
    database: f.database,
    managementToken: "review".repeat(10),
    allowInsecureHttp: true,
    deliver: async (_reference, request) => {
      if (request.action === "start_conversation") return f.native.start(request);
      if (request.action === "stop_conversation")
        return f.native.stop(request.executionReference, request.requestId);
      return { accepted: true };
    },
  });
}, 60_000);
afterAll(async () => {
  await host?.close();
  await f?.close();
});

function value(outcome: ControlToolOutcome) {
  if ("waiting" in outcome) throw new Error("Expected a settled reply");
  return JSON.parse(
    outcome.result.content
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join(""),
  );
}
async function child(task: string) {
  const run = await f.command({ action: "run", task });
  expect(await host.executeTool(run, () => true)).toEqual({ waiting: true });
  const entry = f.children.get(run.operationId)!;
  return { run, view: { ...entry.request.view, conversationId: entry.conversationId } };
}

it("characterizes a later progress notification masking an outstanding supervisor decision", async () => {
  const c = await child("Decision and progress");
  const decision = await f.command(
    { reason: "need_decision", message: "Choose A or B" },
    c.view,
    "contact_supervisor",
  );
  expect(await host.executeTool(decision, () => true)).toHaveProperty("waiting", true);
  expect(value(await host.executeTool(c.run, () => true)).state).toBe("blocked");
  const progress = await f.command(
    { reason: "progress_update", message: "Still checking" },
    c.view,
    "contact_supervisor",
  );
  await host.executeTool(progress, () => true);
  const pending = await f.command({ action: "pending" }, undefined, "subagent_supervisor");
  expect(value(await host.executeTool(pending, () => true)).requests).toEqual(
    expect.arrayContaining([expect.objectContaining({ requestId: decision.operationId })]),
  );
  expect(await host.executeTool(c.run, () => true)).toEqual({ waiting: true });
  process.stdout.write(
    JSON.stringify({
      case: "progress_masks_decision",
      pendingDecisionStillExists: true,
      parentStateBefore: "blocked",
      parentStateAfter: "waiting",
      realPostgres: true,
    }) + "\n",
  );
});

it("characterizes cancelled child wait returning blocked while a supervisor request remains pending", async () => {
  const c = await child("Cancel while awaiting decision");
  const decision = await f.command(
    { reason: "need_decision", message: "Need parent decision" },
    c.view,
    "contact_supervisor",
  );
  await host.executeTool(decision, () => true);
  const cancel = await f.command({ action: "cancel", target: c.run.operationId });
  await host.executeTool(cancel, () => true);
  // This native-record fixture stops the generation only. Represent the
  // outstanding Tool's abort settlement too, as a real Harness would do.
  const { rows } = await sql<{ body: string }>`select l.body from pi_durable_records r
    join pi_durable_log l using(tenant_id,session_id,seq,ordinal)
    where r.tenant_id=${f.scope.tenantId}::uuid and r.session_id=${f.scope.piSessionId}
      and r.kind='task' and r.id=${decision.taskId}`.execute(f.database);
  const task = JSON.parse(rows[0]!.body).value;
  task.abortRequested = true;
  task.state = { status: "terminal", outcome: { status: "aborted" } };
  await f.append([{ type: "task", value: task }], c.view);
  const status = await f.command({ action: "status", target: c.run.operationId });
  expect(value(await host.executeTool(status, () => true)).state).toBe("cancelled");
  const wait = await f.command({ action: "wait", target: c.run.operationId });
  expect(value(await host.executeTool(wait, () => true)).state).toBe("blocked");
  const pending = await f.command({ action: "pending" }, undefined, "subagent_supervisor");
  expect(value(await host.executeTool(pending, () => true)).requests).toEqual(
    expect.arrayContaining([expect.objectContaining({ requestId: decision.operationId })]),
  );
  process.stdout.write(
    JSON.stringify({
      case: "terminal_child_still_blocked",
      childState: "cancelled",
      waitState: "blocked",
      requestStillListed: true,
      realPostgres: true,
    }) + "\n",
  );
});

it("characterizes direct-child discovery before a launch result exposes its identity", async () => {
  const c = await child("One owned child");
  const before = f.children.size;
  expect(await host.executeTool(c.run, () => true)).toEqual({ waiting: true });
  expect(f.children.size).toBe(before); // Same request is correctly deduplicated.
  expect(() => prepareSubagentArguments({ action: "list" })).toThrow();
  for (const target of [c.run.nativeCallId, `task:${c.run.taskId}`]) {
    const lookup = await f.command({ action: "status", target });
    expect(await host.executeTool(lookup, () => true)).toMatchObject({ isError: true });
  }
  const known = await f.command({ action: "status", target: c.run.operationId });
  expect(value(await host.executeTool(known, () => true)).state).toBe("running");
  const different = await f.command({ action: "run", task: "One owned child" });
  await host.executeTool(different, () => true);
  expect(f.children.size).toBe(before + 1);
  process.stdout.write(
    JSON.stringify({
      case: "child_discovery",
      sameCommandDeduplicated: true,
      providerCallIdLookup: "rejected",
      nativeTaskIdLookup: "rejected",
      listAction: "absent",
      knownExecutionIdWorks: true,
      distinctCommandCreatesAnotherChild: true,
    }) + "\n",
  );
});

it("measures repeat reconciliation of an already acknowledged child without another Worker call", async () => {
  const c = await child("Measure repeat reconciliation");
  const statements = new WeakMap<object, string>();
  const queries: string[] = [];
  const measured = f.database.withPlugin({
    transformQuery({ node, queryId }) {
      statements.set(queryId, f.database.getExecutor().compileQuery(node, queryId).sql);
      return node;
    },
    async transformResult({ queryId, result }) {
      queries.push(statements.get(queryId)!);
      return result;
    },
  });
  let workerCalls = 0;
  const controller = new SubagentController({
    database: measured,
    managementToken: "review".repeat(10),
    allowInsecureHttp: true,
    deliver: async () => {
      workerCalls++;
      throw new Error("Unexpected repeat native start");
    },
  });
  try {
    expect(await controller.executeTool(c.run, () => true)).toEqual({ waiting: true });
    expect(workerCalls).toBe(0);
    expect(queries.length).toBeGreaterThan(1);
    process.stdout.write(
      JSON.stringify({
        case: "pending_child_revisit_sql",
        businessSql: queries.length,
        workerCalls,
        lockedReads: queries.filter((q) => q.includes("for no key update")).length,
        excludesBeginCommit: true,
        realPostgres: true,
      }) + "\n",
    );
  } finally {
    await controller.close();
  }
});

it("composes production supervisor wake wiring and observes repeated reads without any new decision", async () => {
  const c = await child("Wait without spinning");
  let fact: AcceptedDurableCommitFact | undefined;
  f.setPublisher(async (next) => {
    await f.projection.apply(
      next.commit as unknown as StoredDurableBatch,
      next.origins,
      { topic: "review", partition: 0, offset: BigInt(next.commit.seq) },
      { controlTools: next.tools },
    );
    fact = next;
  });
  const call = await f.command(
    { reason: "need_decision", message: "Await a later answer" },
    c.view,
    "contact_supervisor",
  );
  expect(fact).toBeDefined();
  let queries = 0,
    executions = 0,
    wakeups = 0,
    replies = 0;
  const measured = f.database.withPlugin({
    transformQuery({ node }) {
      return node;
    },
    async transformResult({ result }) {
      queries++;
      return result;
    },
  });
  let dispatcher: ControlToolDispatcher | undefined;
  let settled!: () => void;
  const repeated = new Promise<void>((resolve) => {
    settled = resolve;
  });
  const limit = 20; // Contain the observed feedback loop in this owned fixture.
  const controller = new SubagentController({
    database: measured,
    managementToken: "review".repeat(10),
    allowInsecureHttp: true,
    changed: (tenant, session) => {
      wakeups++;
      if (executions < limit) dispatcher!.wake(tenant, session);
    },
  });
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  dispatcher = new ControlToolDispatcher({
    database: measured,
    partitions: 1,
    ownsPartition: () => true,
    execute: async (command, current) => {
      executions++;
      const result = await controller.executeTool(command, current);
      expect(result).toHaveProperty("waiting", true);
      if (executions >= limit) settled();
      return result;
    },
    publish: async () => {
      replies++;
    },
  });
  try {
    const start = performance.now();
    await dispatcher.consume({
      fact: fact!,
      partition: 0,
      offset: BigInt(fact!.commit.seq),
      topic: "review",
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        repeated,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Expected repeated wakeups")), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    await dispatcher.close();
    expect(executions).toBe(limit);
    expect(wakeups).toBe(limit);
    expect(replies).toBe(0);
    const rows = await f.database
      .selectFrom("subagent_supervisor_requests")
      .select("id")
      .where("id", "=", call.operationId)
      .execute();
    expect(rows).toHaveLength(1);
    process.stdout.write(
      JSON.stringify({
        case: "supervisor_self_wakeup",
        executions,
        wakeups,
        businessSql: queries,
        elapsedMs: Math.round(performance.now() - start),
        supervisorRows: rows.length,
        replies,
        timerAdvances: 0,
        nativeUpdatesAfterConsume: 0,
        boundedByFixtureAt: limit,
        realPostgres: true,
      }) + "\n",
    );
  } finally {
    await dispatcher.close();
    await controller.close();
    vi.useRealTimers();
  }
});
