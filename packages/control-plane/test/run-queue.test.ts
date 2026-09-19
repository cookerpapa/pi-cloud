import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import {
  TurnExecutionCancelledError,
  TurnExecutionBackendError,
} from "@pi-cloud/runtime-core/run-executor";
import {
  RunCancellationExecutor,
  TurnCancellationBackendError,
} from "@pi-cloud/runtime-core/run-cancellation-executor";
import { ExecutionStreamProjector } from "@pi-cloud/runtime-core";
import { parseKafkaAcceptedFact } from "@pi-cloud/runtime-core/kafka-accepted-fact";
import { confirmAgentExit } from "@pi-cloud/runtime-core/quarantined-session-recovery";
import { transitionCurrentRun } from "@pi-cloud/runtime-core/run-state";
import { PiCloudMetrics } from "@pi-cloud/observability";
import { sql, type Kysely } from "kysely";
import { Pool } from "pg";
import { beforeAll, beforeEach, afterEach, afterAll, describe, expect, it, vi } from "vitest";
import { ControlPlaneStore, createPrivateTenant } from "../src/index.ts";
import { createTestWorker } from "./admit-test-execution.ts";

const endpoint = process.env.PI_CLOUD_PI_SESSION_CONFORMANCE_DATABASE_URL;
describe.skipIf(!endpoint).sequential("Run queue authority", () => {
  let admin: Pool,
    database: Kysely<Database>,
    store: ControlPlaneStore,
    tenantId: string,
    name: string,
    offset: bigint;
  beforeAll(() => {
    admin = new Pool({ connectionString: endpoint!, max: 1 });
  });
  beforeEach(async () => {
    name = `pi_queue_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database "${name}"`);
    const url = new URL(endpoint!);
    url.pathname = `/${name}`;
    database = createDatabase({ connectionString: url.toString(), maxConnections: 8 });
    await runMigrations(database, "up");
    const tenant = await createPrivateTenant(database, {
      slug: "queue",
      ownerDisplayName: "Queue test",
    });
    tenantId = tenant.tenantId;
    store = new ControlPlaneStore({ database, ...tenant });
    offset = 0n;
  }, 60000);
  afterEach(async () => {
    await database?.destroy();
    await admin.query(`drop database "${name}"`);
  });
  afterAll(async () => {
    await admin?.end();
  });
  async function conversation(label: string) {
    const p = await store.createProject({ name: label, source: { kind: "empty" } });
    return store.createSession(p.projectId, p.workspaceId, label, "elastic");
  }
  async function lane(parent: Awaited<ReturnType<typeof conversation>>, lane: string) {
    const s = await store.createSession(parent.projectId, parent.workspaceId, lane, "elastic");
    await database
      .updateTable("sessions")
      .set({ pi_session_id: parent.sessionId, pi_session_lane: lane })
      .where("id", "=", s.sessionId)
      .execute();
    return s;
  }
  async function seal(runId: string) {
    const row = await database
      .selectFrom("outbox")
      .select("payload")
      .where(sql<boolean>`payload#>>'{scope,runId}'=${runId}`)
      .executeTakeFirstOrThrow();
    const record = {
      fact: parseKafkaAcceptedFact(JSON.stringify(row.payload)),
      topic: "queue-tests",
      partition: 0,
      offset: offset++,
    };
    await new ExecutionStreamProjector(database).project(record);
    return record;
  }
  const activeOwners = () =>
    database.selectFrom("session_leases").selectAll().where("released_at", "is", null).execute();

  it("measures only committed claim stages without recording query or tenant labels", async () => {
    const s = await conversation("timing"),
      accepted = await store.acceptTurn(s.sessionId, "first", { prompt: "metric fixture" });
    const metrics = new PiCloudMetrics("claim-test"),
      queries: string[] = [];
    const measured = database.withPlugin({
      transformQuery({ node, queryId }) {
        queries.push(database.getExecutor().compileQuery(node, queryId).sql);
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    const worker = await createTestWorker(database);
    const executor = worker.executor(
      {
        async execute(r) {
          expect(r).toMatchObject({ sessionKind: "conversation", workspaceSeedKind: "empty" });
          return { stopReason: "stop" };
        },
      },
      { database: measured, metrics },
    );
    expect(await executor.dispatchNext()).toMatchObject({
      status: "completed",
      runId: accepted.runId,
    });
    expect(await executor.dispatchRun(accepted.runId)).toEqual({ status: "idle" });
    const candidates = queries.filter((q) => q.startsWith('with "claim_candidate"'));
    expect(candidates).toHaveLength(2);
    expect(candidates.every((q) => q.includes('"claim_candidate" as materialized'))).toBe(true);
    expect(candidates[0]).toContain(
      "candidate.state = 'queued' and candidate.ready_at is not null",
    );
    expect(candidates[0]).not.toContain("from runs as earlier_run");
    expect(queries.some((q) => q.includes('update "sandboxes"'))).toBe(false);
    expect(queries.filter((q) => q.startsWith('with "started_turn"'))).toHaveLength(1);
    const stages = await metrics.runClaimStageDuration.get();
    const counts = stages.values.filter((v) => v.metricName?.endsWith("_count"));
    expect(counts.map((v) => v.labels.stage).sort()).toEqual([
      "admitted_running",
      "candidate_context",
      "configuration",
      "finish",
      "ownership",
      "transaction_begin",
    ]);
    expect(counts.every((v) => v.value === 1)).toBe(true);
    expect(
      counts.every((v) => Object.keys(v.labels).every((k) => ["service", "stage"].includes(k))),
    ).toBe(true);
  });

  it("rolls back lifecycle state if the transition record cannot be inserted", async () => {
    const s = await conversation("rollback"),
      accepted = await store.acceptTurn(s.sessionId, "first", { prompt: "test" });
    const worker = await createTestWorker(database);
    const executor = worker.executor({
      async execute(r) {
        const read = () =>
          database
            .selectFrom("runs")
            .select(["state", "row_version"])
            .where("id", "=", r.runId)
            .executeTakeFirstOrThrow();
        const before = await read();
        const prior = await database
          .selectFrom("run_transitions")
          .select("id")
          .where("run_id", "=", r.runId)
          .executeTakeFirstOrThrow();
        await expect(
          database.transaction().execute((tx) =>
            transitionCurrentRun(tx, r, {
              runState: "settling",
              reason: "rollback-test",
              now: new Date(),
              transitionId: prior.id,
            }),
          ),
        ).rejects.toThrow(/duplicate key/);
        expect(await read()).toEqual(before);
        return { stopReason: "stop" };
      },
    });
    expect(await executor.dispatchRun(accepted.runId)).toMatchObject({ status: "completed" });
  });

  it("settles an environment failure against the single Run identity", async () => {
    const s = await conversation("environment-failure");
    const accepted = await store.acceptTurn(s.sessionId, "first", { prompt: "test" });
    const worker = await createTestWorker(database);
    const executor = worker.executor({
      async execute(_request, lifecycle) {
        lifecycle.executionExited();
        throw new TurnExecutionBackendError("environment_preflight_failed", "Probe failed", false);
      },
    });
    expect(await executor.dispatchRun(accepted.runId)).toMatchObject({
      status: "failed",
      failureCode: "environment_preflight_failed",
    });
    const evidence = await database
      .selectFrom("environment_validations")
      .selectAll()
      .where("run_id", "=", accepted.runId)
      .execute();
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      status: "failed",
      failure_code: "environment_preflight_failed",
    });
    await seal(accepted.runId);
    expect((await store.getRun(accepted.runId)).state).toBe("failed");
  });

  it.each(["exit-first", "seal-first", "no-exit-proof"])(
    "recovers cancellation failure only after exit and seal (%s)",
    async (order) => {
      const s = await conversation(`cancel-${order}`),
        a = await store.acceptTurn(s.sessionId, "first", { prompt: "wait" });
      const worker = await createTestWorker(database),
        entered = Promise.withResolvers<void>(),
        interrupt = Promise.withResolvers<void>();
      let identity!: Parameters<typeof confirmAgentExit>[1], reference!: string;
      const executor = worker.executor({
        async execute(r, l, admission) {
          identity = r;
          reference = admission!.executionReference;
          entered.resolve();
          await interrupt.promise;
          if (order !== "no-exit-proof") l.executionExited();
          throw new TurnExecutionCancelledError("user_request", false);
        },
      });
      const executing = executor.dispatchRun(a.runId);
      void executing.catch(entered.reject);
      await entered.promise;
      try {
        await store.acceptTurnCancellation(s.sessionId, a.turnId, "cancel", {});
        const release = vi.fn(worker.coordinator.releaseCurrent.bind(worker.coordinator));
        const cancellation = new RunCancellationExecutor({
          database,
          executionAuthority: {
            assertCurrent: worker.coordinator.assertCurrent.bind(worker.coordinator),
            releaseCurrent: release,
            assertCurrentOrExpired: worker.coordinator.assertCurrentOrExpired.bind(
              worker.coordinator,
            ),
          },
          backend: {
            async cancel(_r, l) {
              await l.started({ executionReference: reference });
              throw new TurnCancellationBackendError(
                "cleanup_failed",
                "Cleanup was not confirmed",
                false,
              );
            },
          },
        });
        expect(await cancellation.dispatchTargetRun(a.runId)).toMatchObject({
          status: "failed",
          phase: "after_start",
          failureCode: "cleanup_failed",
        });
        expect(release).toHaveBeenCalledOnce();
        await expect(
          store.acceptTurn(s.sessionId, "early", { prompt: "next" }),
        ).rejects.toMatchObject({ code: "conflict" });
        if (order === "exit-first") {
          interrupt.resolve();
          await executing;
          await expect(
            store.acceptTurn(s.sessionId, "unsealed", { prompt: "next" }),
          ).rejects.toMatchObject({ code: "conflict" });
        }
        const closed = await seal(a.runId);
        if (order !== "exit-first") {
          await expect(
            store.acceptTurn(s.sessionId, "still-alive", { prompt: "next" }),
          ).rejects.toMatchObject({ code: "conflict" });
          interrupt.resolve();
          await executing;
        }
        if (order === "no-exit-proof") {
          await database
            .updateTable("session_leases")
            .set({
              acquired_at: sql<Date>`clock_timestamp()-interval '2 seconds'`,
              valid_until: sql<Date>`clock_timestamp()-interval '1 second'`,
            })
            .where("tenant_id", "=", tenantId)
            .execute();
          await expect(
            store.acceptTurn(s.sessionId, "expired", { prompt: "next" }),
          ).rejects.toMatchObject({ code: "conflict" });
          await confirmAgentExit(database, { ...identity, tenantId: crypto.randomUUID() });
          await expect(
            store.acceptTurn(s.sessionId, "foreign", { prompt: "next" }),
          ).rejects.toMatchObject({ code: "conflict" });
          await confirmAgentExit(database, identity);
        }
        const next = await store.acceptTurn(s.sessionId, "next", { prompt: "next" });
        expect(next.runId).not.toBe(a.runId);
        await new ExecutionStreamProjector(database).project(closed);
        await confirmAgentExit(database, identity);
        expect((await store.acceptTurn(s.sessionId, "next", { prompt: "next" })).runId).toBe(
          next.runId,
        );
        const secondWorker = await createTestWorker(database);
        const failed = secondWorker.executor({
          async execute() {
            throw new TurnExecutionBackendError("new_failure", "Exit unconfirmed", false, true);
          },
        });
        expect(await failed.dispatchRun(next.runId)).toMatchObject({ status: "failed" });
        await seal(next.runId);
        await confirmAgentExit(database, identity);
        await expect(
          store.acceptTurn(s.sessionId, "stale-proof", { prompt: "next" }),
        ).rejects.toMatchObject({ code: "conflict" });
      } finally {
        interrupt.resolve();
        await executing;
      }
    },
  );

  it("retries a rolled-back terminal commit without re-executing the Agent Loop", async () => {
    const s = await conversation("terminal"),
      a = await store.acceptTurn(s.sessionId, "first", { prompt: "once" });
    let fail = true,
      executions = 0;
    const measured = database.withPlugin({
      transformQuery({ node, queryId }) {
        const q = database.getExecutor().compileQuery(node, queryId);
        if (fail && q.sql.includes('update "runs"') && q.parameters.includes("completed")) {
          fail = false;
          throw Object.assign(Error("injected SQL rollback"), { code: "40P01" });
        }
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    const worker = await createTestWorker(database),
      executor = worker.executor(
        {
          async execute() {
            executions++;
            return { stopReason: "stop" };
          },
        },
        { database: measured },
      );
    expect(await executor.dispatchRun(a.runId)).toMatchObject({ status: "completed" });
    expect(executions).toBe(1);
    expect(fail).toBe(false);
    expect(
      await database
        .selectFrom("run_transitions")
        .select("id")
        .where("run_id", "=", a.runId)
        .where("to_state", "=", "completed")
        .execute(),
    ).toHaveLength(1);
  });

  it("uses Run as the sole idempotent mailbox and serializes one Session", async () => {
    const s = await conversation("FIFO"),
      a = await store.acceptTurn(s.sessionId, "first", { prompt: "first" });
    expect(await store.acceptTurn(s.sessionId, "first", { prompt: "first" })).toMatchObject({
      runId: a.runId,
      replayed: true,
    });
    const b = await store.acceptTurn(s.sessionId, "second", { prompt: "second" });
    expect([a.mailboxPosition, b.mailboxPosition]).toEqual([1, 2]);
    const worker = await createTestWorker(database),
      entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const executor = worker.executor({
      async execute(r) {
        if (r.runId === a.runId) {
          entered.resolve();
          await release.promise;
        }
        return { stopReason: "stop" };
      },
    });
    const first = executor.dispatchNext();
    void first.catch(entered.reject);
    await entered.promise;
    try {
      expect(await executor.dispatchNext()).toEqual({ status: "idle" });
    } finally {
      release.resolve();
      await first;
    }
    expect(await executor.dispatchNext()).toEqual({ status: "idle" });
    await seal(a.runId);
    expect(await executor.dispatchNext()).toMatchObject({ status: "completed", runId: b.runId });
  });

  it("persists cancellation as a typed control request without a queue Outbox", async () => {
    const s = await conversation("cancel"),
      a = await store.acceptTurn(s.sessionId, "first", { prompt: "wait" });
    const worker = await createTestWorker(database),
      entered = Promise.withResolvers<void>(),
      interrupt = Promise.withResolvers<void>(),
      exited = Promise.withResolvers<void>();
    let reference!: string;
    const executor = worker.executor({
      async execute(_r, l, admission) {
        reference = admission!.executionReference;
        entered.resolve();
        await interrupt.promise;
        l.executionExited();
        exited.resolve();
        throw new TurnExecutionCancelledError("user_request", false);
      },
    });
    const executing = executor.dispatchRun(a.runId);
    void executing.catch(entered.reject);
    await entered.promise;
    try {
      const accepted = await store.acceptTurnCancellation(s.sessionId, a.turnId, "cancel", {});
      expect(await store.acceptTurnCancellation(s.sessionId, a.turnId, "cancel", {})).toMatchObject(
        { controlRequestId: accepted.controlRequestId, replayed: true },
      );
      expect(await database.selectFrom("outbox").select("id").execute()).toEqual([]);
      const cancellation = new RunCancellationExecutor({
        database,
        executionAuthority: worker.coordinator,
        backend: {
          async cancel(r, l) {
            await l.started({ executionReference: reference });
            interrupt.resolve();
            await exited.promise;
            return { reason: r.reason, forced: false };
          },
        },
      });
      expect(await cancellation.dispatchTargetRun(a.runId)).toMatchObject({ status: "cancelled" });
      await executing;
      expect(
        await database.selectFrom("turn_control_requests").select(["kind", "state"]).execute(),
      ).toEqual([{ kind: "cancel", state: "completed" }]);
      await seal(a.runId);
      expect((await store.getRun(a.runId)).state).toBe("cancelled");
    } finally {
      interrupt.resolve();
      await executing;
    }
  });

  it("lets competing Workers claim different ready Runs without a candidate scan", async () => {
    const a = await conversation("A"),
      b = await conversation("B");
    const ar = await store.acceptTurn(a.sessionId, "first", { prompt: "A" }),
      br = await store.acceptTurn(b.sessionId, "first", { prompt: "B" });
    const workers = await Promise.all([createTestWorker(database), createTestWorker(database)]);
    const entered: string[] = [],
      gate = Promise.withResolvers<void>();
    const jobs = workers.map((w) =>
      w
        .executor({
          async execute(r) {
            entered.push(r.runId);
            if (entered.length === 2) gate.resolve();
            await gate.promise;
            return { stopReason: "stop" };
          },
        })
        .dispatchNext(),
    );
    try {
      await vi.waitFor(() => expect(entered).toHaveLength(2));
    } finally {
      gate.resolve();
    }
    expect((await Promise.all(jobs)).map((r) => r.status)).toEqual(["completed", "completed"]);
    expect(new Set(entered)).toEqual(new Set([ar.runId, br.runId]));
  });

  it("keeps every active Lane of one physical Pi Session on its owner Worker", async () => {
    const main = await conversation("family"),
      child = await lane(main, "child");
    const a = await store.acceptTurn(main.sessionId, "first", { prompt: "main" }),
      b = await store.acceptTurn(child.sessionId, "first", { prompt: "child" });
    const owner = await createTestWorker(database),
      foreign = await createTestWorker(database);
    const entered = new Set<string>(),
      gates = new Map([a.runId, b.runId].map((id) => [id, Promise.withResolvers<void>()]));
    const executor = owner.executor({
      async execute(r) {
        entered.add(r.runId);
        await gates.get(r.runId)!.promise;
        return { stopReason: "stop" };
      },
    });
    const other = foreign.executor({
      async execute() {
        return { stopReason: "stop" };
      },
    });
    const first = executor.dispatchRun(a.runId);
    await vi.waitFor(() => expect(entered.has(a.runId)).toBe(true));
    let second: Promise<unknown> | undefined;
    try {
      expect(await other.dispatchRun(b.runId)).toEqual({ status: "idle" });
      second = executor.dispatchRun(b.runId);
      await vi.waitFor(() => expect(entered.has(b.runId)).toBe(true));
      expect(await activeOwners()).toHaveLength(1);
      gates.get(a.runId)!.resolve();
      await first;
      await seal(a.runId);
      const next = await store.acceptTurn(main.sessionId, "next", { prompt: "next" });
      expect(await other.dispatchRun(next.runId)).toEqual({ status: "idle" });
      gates.get(b.runId)!.resolve();
      await second;
      expect(await activeOwners()).toHaveLength(0);
      expect(await other.dispatchRun(next.runId)).toEqual({ status: "idle" });
      await seal(b.runId);
      expect(await other.dispatchRun(next.runId)).toMatchObject({ status: "completed" });
      expect((await store.getRun(next.runId)).workerId).toBe(foreign.workerId);
    } finally {
      for (const g of gates.values()) g.resolve();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
    }
  });

  it("atomically elects one Worker when two Lanes of a cold Pi Session race", async () => {
    const main = await conversation("election"),
      child = await lane(main, "child");
    const a = await store.acceptTurn(main.sessionId, "first", { prompt: "main" }),
      b = await store.acceptTurn(child.sessionId, "first", { prompt: "child" });
    const workers = await Promise.all([createTestWorker(database), createTestWorker(database)]),
      gate = Promise.withResolvers<void>(),
      entered: string[] = [];
    const executors = workers.map((w) =>
      w.executor({
        async execute(r) {
          entered.push(r.runId);
          await gate.promise;
          return { stopReason: "stop" };
        },
      }),
    );
    const jobs = [executors[0]!.dispatchRun(a.runId), executors[1]!.dispatchRun(b.runId)];
    try {
      await vi.waitFor(() => expect(entered).toHaveLength(1));
      expect(await activeOwners()).toHaveLength(1);
    } finally {
      gate.resolve();
    }
    const results = await Promise.allSettled(jobs);
    expect(
      results.filter((r) => r.status === "fulfilled" && r.value.status === "completed"),
    ).toHaveLength(1);
    expect(
      await database.selectFrom("runs").select("id").where("lease_id", "is not", null).execute(),
    ).toHaveLength(1);
  });
});
