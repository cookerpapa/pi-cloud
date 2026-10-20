import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { nativeSubagentFixture } from "./native-subagent-fixture.ts";
import { SubagentController } from "../src/subagent-controller.ts";
import { ControlToolDispatcher, type ControlToolOutcome } from "../src/control-tool-dispatcher.ts";
import type { AcceptedDurableCommitFact } from "../../runtime-core/src/accepted-fact.ts";
import type { StoredDurableBatch } from "../../pi-session-postgres/src/durable/types.ts";
import { PostgresSubagentSupervisorChannel } from "../../subagent-control/src/postgres-subagent-supervisor-channel.ts";

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

it("keeps an outstanding supervisor decision visible after newer progress", async () => {
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
  const nextDecision = await f.command(
    { reason: "need_decision", message: "A second decision" },
    c.view,
    "contact_supervisor",
  );
  await host.executeTool(nextDecision, () => true);
  const pending = await f.command({ action: "pending" }, undefined, "subagent_supervisor");
  expect(value(await host.executeTool(pending, () => true)).requests).toEqual(
    expect.arrayContaining([expect.objectContaining({ requestId: decision.operationId })]),
  );
  expect(value(await host.executeTool(c.run, () => true)).state).toBe("blocked");
  expect(value(await host.executeTool(c.run, () => true)).supervisorRequest.requestId).toBe(
    decision.operationId,
  );
  const reply = await f.command(
    { action: "reply", replyTo: decision.operationId, message: "Choose A" },
    undefined,
    "subagent_supervisor",
  );
  await host.executeTool(reply, () => true);
  expect(value(await host.executeTool(c.run, () => true)).supervisorRequest.requestId).toBe(
    nextDecision.operationId,
  );
  process.stdout.write(
    JSON.stringify({
      case: "progress_masks_decision",
      pendingDecisionStillExists: true,
      parentStateBefore: "blocked",
      parentStateAfter: "blocked",
      realPostgres: true,
    }) + "\n",
  );
});

it("rejects a new supervisor reply when the child ends after the request lock is acquired", async () => {
  const c = await child("Reply versus cancellation");
  const decision = await f.command(
    { reason: "need_decision", message: "Cancel before answer commits" },
    c.view,
    "contact_supervisor",
  );
  await host.executeTool(decision, () => true);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const queries = new WeakMap<object, string>();
  const channel = new PostgresSubagentSupervisorChannel(
    f.database.withPlugin({
      transformQuery({ node, queryId }) {
        queries.set(queryId, f.database.getExecutor().compileQuery(node, queryId).sql);
        return node;
      },
      async transformResult({ result, queryId }) {
        if (queries.get(queryId)?.includes('for update of "request"')) {
          entered.resolve();
          await release.promise;
        }
        return result;
      },
    }),
  );
  const replying = channel.reply({
    tenantId: f.scope.tenantId,
    parentSessionId: f.scope.sessionId,
    requestId: decision.operationId,
    message: "Late answer",
  });
  void replying.catch(() => {});
  try {
    await entered.promise;
    await f.settle(c.run.operationId, "cancelled");
    const { rows } = await sql<{ body: string }>`select l.body from pi_durable_records r
      join pi_durable_log l using(tenant_id,session_id,seq,ordinal)
      where r.tenant_id=${f.scope.tenantId}::uuid and r.session_id=${f.scope.piSessionId}
        and r.kind='task' and r.id=${decision.taskId}`.execute(f.database);
    const task = JSON.parse(rows[0]!.body).value;
    task.abortRequested = true;
    task.state = { status: "terminal", outcome: { status: "aborted" } };
    await f.append([{ type: "task", value: task }], c.view);
    release.resolve();
    await expect(replying).rejects.toThrow("child has finished");
    expect(
      (await channel.request(f.scope.tenantId, decision.operationId)).replyMessage,
    ).toBeUndefined();
  } finally {
    release.resolve();
    await replying.catch(() => {});
  }
});

it("returns cancellation instead of a stale supervisor question", async () => {
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
  expect(value(await host.executeTool(wait, () => true)).state).toBe("cancelled");
  const pending = await f.command({ action: "pending" }, undefined, "subagent_supervisor");
  expect(value(await host.executeTool(pending, () => true)).requests).not.toEqual(
    expect.arrayContaining([expect.objectContaining({ requestId: decision.operationId })]),
  );
  const reply = await f.command(
    { action: "reply", replyTo: decision.operationId, message: "Too late" },
    undefined,
    "subagent_supervisor",
  );
  expect(await host.executeTool(reply, () => true)).toMatchObject({ isError: true });
  process.stdout.write(
    JSON.stringify({
      case: "terminal_child_still_blocked",
      childState: "cancelled",
      waitState: "cancelled",
      requestStillListed: false,
      realPostgres: true,
    }) + "\n",
  );
});

it("deduplicates one launch while preserving distinct model commands", async () => {
  const c = await child("One owned child");
  const before = f.children.size;
  expect(await host.executeTool(c.run, () => true)).toEqual({ waiting: true });
  expect(f.children.size).toBe(before); // Same request is correctly deduplicated.
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
    expect(queries).toHaveLength(2);
    expect(queries.filter((q) => q.includes("for no key update"))).toHaveLength(0);
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

it("stays quiescent on unchanged supervisor reads and responds to ordered changes", async () => {
  const c = await child("Wait without spinning");
  let fact: AcceptedDurableCommitFact | undefined;
  f.setPublisher(async (next) => {
    await f.projection.apply(
      next.commit as unknown as StoredDurableBatch,
      next.origins,
      { topic: "supervision", partition: 0, offset: BigInt(next.commit.seq) },
      { controlTools: next.tools },
    );
    fact = next;
  });
  const pendingCall = await f.command(
    { reason: "need_decision", message: "Await a later answer" },
    c.view,
    "contact_supervisor",
  );
  const call = fact!;
  let executions = 0,
    processed = 0,
    replies = 0;
  const changes = async () =>
    Number(
      (
        await sql<{ n: string }>`select count(*)::text as n from outbox
    where tenant_id=${f.scope.tenantId}::uuid and aggregate_type='session_control_change'
      and payload->>'entity'='subagent_state'`.execute(f.database)
      ).rows[0]!.n,
    );
  const before = await changes();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const controller = new SubagentController({
    database: f.database,
    managementToken: "supervision".repeat(5),
    allowInsecureHttp: true,
  });
  const dispatcher = new ControlToolDispatcher({
    database: f.database,
    partitions: 1,
    ownsPartition: () => true,
    execute: async (command, current) => {
      executions++;
      const outcome = await controller.executeTool(command, current);
      processed++;
      return outcome;
    },
    publish: async () => {
      replies++;
    },
  });
  try {
    await dispatcher.consume({
      fact: call,
      partition: 0,
      offset: BigInt(call.commit.seq),
      topic: "supervision",
    });
    await vi.waitFor(() => expect(processed).toBe(1));
    expect(await changes()).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(executions).toBe(1);
    expect(replies).toBe(0);
    // Deliver the persisted contact's ordered change, as the Session Projector does.
    dispatcher.wake(f.scope.tenantId, f.scope.piSessionId);
    await vi.waitFor(() => expect(processed).toBe(2));
    expect(await changes()).toBe(before + 1); // Reading the same request wrote nothing.
    await vi.advanceTimersByTimeAsync(3000);
    expect(executions).toBe(2);
    const operationId = pendingCall.operationId;
    const reply = await f.command(
      { action: "reply", replyTo: operationId, message: "Choose A" },
      undefined,
      "subagent_supervisor",
    );
    await host.executeTool(reply, () => true);
    expect(await changes()).toBe(before + 2);
    dispatcher.wake(f.scope.tenantId, f.scope.piSessionId);
    await vi.waitFor(() => expect(replies).toBe(1));
    expect(executions).toBe(3);
    process.stdout.write(
      JSON.stringify({
        case: "supervisor_ordered_wake",
        executions,
        replies,
        actualChanges: 2,
        selfWakeups: 0,
        realPostgres: true,
      }) + "\n",
    );
  } finally {
    await dispatcher.close();
    await controller.close();
    vi.useRealTimers();
  }
});
