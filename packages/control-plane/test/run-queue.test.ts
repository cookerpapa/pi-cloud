import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { RunExecutor, type TurnExecutionBackend } from "@pi-cloud/runtime-core/run-executor";
import {
  TurnExecutionCancelledError,
  TurnExecutionBackendError,
} from "@pi-cloud/runtime-core/run-executor";
import {
  RunCancellationExecutor,
  TurnCancellationBackendError,
} from "@pi-cloud/runtime-core/run-cancellation-executor";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { sql, type Kysely } from "kysely";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ControlPlaneStore, createPrivateTenant } from "../src/index.ts";
import { ExecutionStreamProjector } from "../../runtime-core/src/execution-stream-projection.ts";
import { parseKafkaAcceptedFact } from "../../runtime-core/src/kafka-accepted-fact.ts";
import { confirmAgentExit } from "../../runtime-core/src/quarantined-session-recovery.ts";
import { PiCloudMetrics } from "@pi-cloud/observability";
import { transitionCurrentRunAttempt } from "@pi-cloud/runtime-core/run-attempt-state";

let pglite: PGlite;
let socket: PGLiteSocketServer;
let database: Kysely<Database>;
let store: ControlPlaneStore;
let tenantId: string;
const external = process.env.PI_CLOUD_PI_SESSION_CONFORMANCE_DATABASE_URL;
let admin: Pool | undefined;
let testDatabase: string | undefined;

beforeAll(async () => {
  if (external) {
    admin = new Pool({ connectionString: external, max: 1 });
    testDatabase = `pi_queue_${crypto.randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database "${testDatabase}"`);
    const url = new URL(external);
    url.pathname = `/${testDatabase}`;
    database = createDatabase({ connectionString: url.toString(), maxConnections: 8 });
  } else {
    pglite = await PGlite.create();
    socket = new PGLiteSocketServer({
      db: pglite,
      host: "127.0.0.1",
      port: 0,
      maxConnections: 8,
    });
    await socket.start();
    database = createDatabase({
      connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
      maxConnections: 8,
    });
  }
  await runMigrations(database, "up");
  const tenant = await createPrivateTenant(database, {
    slug: "run-queue-test",
    ownerDisplayName: "Run Queue Test",
  });
  tenantId = tenant.tenantId;
  store = new ControlPlaneStore({
    database,
    tenantId: tenant.tenantId,
    defaultModelProfileId: tenant.defaultModelProfileId,
  });
});

afterAll(async () => {
  await database?.destroy();
  await socket?.stop();
  await pglite?.close();
  if (admin) {
    if (testDatabase) await admin.query(`drop database "${testDatabase}"`);
    await admin.end();
  }
});

describe.sequential("Run queue authority", () => {
  it("measures only committed claim stages without recording query or tenant labels", async () => {
    const project = await store.createProject({ name: "claim timing", source: { kind: "empty" } });
    const session = await store.createSession(
      project.projectId,
      project.workspaceId,
      "timing",
      "elastic",
    );
    const accepted = await store.acceptTurn(session.sessionId, "claim-timing", {
      prompt: "metric fixture",
    });
    const metrics = new PiCloudMetrics("claim-test");
    const candidates: string[] = [];
    const ownerReads: string[] = [];
    const startedWrites: string[] = [];
    const measured = database.withPlugin({
      transformQuery({ node, queryId }) {
        const query = database.getExecutor().compileQuery(node, queryId);
        if (query.sql.startsWith('with "claim_candidate"')) candidates.push(query.sql);
        if (query.sql.startsWith('with "started_turn"')) startedWrites.push(query.sql);
        if (query.sql.startsWith("select ") && query.sql.includes('from "session_leases" as "l"'))
          ownerReads.push(query.sql);
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    const executor = new RunExecutor({
      database: measured,
      metrics,
      claimOwnerId: "claim-timing-worker",
      backend: {
        execute: async (_request, lifecycle) => {
          expect(_request).toMatchObject({
            sessionKind: "conversation",
            workspaceSeedKind: "empty",
          });
          await lifecycle.started();
          return { stopReason: "stop" };
        },
      },
    });
    await expect(executor.dispatchNext()).resolves.toMatchObject({
      status: "completed",
      runId: accepted.runId,
    });
    await expect(executor.dispatchRun(accepted.runId)).resolves.toEqual({ status: "idle" });
    // A generic prepared plan must be able to prove the ready-index predicate;
    // lifecycle constants are code, whereas user/Worker identities remain parameters.
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toContain("candidate.state in ('queued', 'claimed')");
    expect(candidates.every((query) => query.includes('"claim_candidate" as materialized'))).toBe(
      true,
    );
    expect(candidates[0]!.match(/from runs as earlier_run/g)).toHaveLength(1);
    expect(ownerReads).toHaveLength(1);
    expect(startedWrites).toHaveLength(1);
    expect(startedWrites[0]).toContain('"started_session"');
    expect(ownerReads[0]).toContain('"w"."native_writer_sealed_at"');
    const stages = await metrics.runClaimStageDuration.get();
    const counts = stages.values.filter((v) => v.metricName?.endsWith("_count"));
    expect(counts.map((v) => v.labels.stage).sort()).toEqual([
      "candidate_context",
      "configuration",
      "finish",
      "lifecycle_write",
      "ownership",
      "transaction_begin",
    ]);
    expect(counts.every((v) => v.value === 1)).toBe(true);
    expect(
      counts.every((v) =>
        Object.keys(v.labels).every((label) => ["service", "stage"].includes(label)),
      ),
    ).toBe(true);
    const sum = stages.values
      .filter((v) => v.metricName?.endsWith("_sum"))
      .reduce((n, v) => n + v.value, 0);
    const whole = (await metrics.runClaimDuration.get()).values.find(
      (v) => v.metricName?.endsWith("_sum") && v.labels.outcome === "claimed",
    )!.value;
    expect(sum).toBeGreaterThan(0);
    expect(sum).toBeLessThanOrEqual(whole);
  });

  it("rolls back both lifecycle writes if the transition record cannot be inserted", async () => {
    const project = await store.createProject({
      name: "transition rollback",
      source: { kind: "empty" },
    });
    const session = await store.createSession(
      project.projectId,
      project.workspaceId,
      "rollback",
      "elastic",
    );
    const accepted = await store.acceptTurn(session.sessionId, "transition-rollback", {
      prompt: "test",
    });
    const executor = new RunExecutor({
      database,
      claimOwnerId: "rollback-worker",
      backend: {
        async execute(request, lifecycle) {
          const before = await database
            .selectFrom("runs")
            .select(["state", "row_version"])
            .where("id", "=", request.runId)
            .executeTakeFirstOrThrow();
          const prior = await database
            .selectFrom("run_attempt_transitions")
            .select("id")
            .where("attempt_id", "=", request.attemptId)
            .executeTakeFirstOrThrow();
          await expect(
            database.transaction().execute((tx) =>
              transitionCurrentRunAttempt(tx, request, {
                runState: "provisioning",
                attemptState: "provisioning",
                reason: "rollback-test",
                now: new Date(),
                transitionId: prior.id,
              }),
            ),
          ).rejects.toThrow(/duplicate key/);
          expect(
            await database
              .selectFrom("runs")
              .select(["state", "row_version"])
              .where("id", "=", request.runId)
              .executeTakeFirstOrThrow(),
          ).toEqual(before);
          expect(
            await database
              .selectFrom("run_attempts")
              .select(["state", "provisioning_at"])
              .where("id", "=", request.attemptId)
              .executeTakeFirstOrThrow(),
          ).toEqual({ state: "claimed", provisioning_at: null });
          await lifecycle.started();
          return { stopReason: "stop" };
        },
      },
    });
    await expect(executor.dispatchRun(accepted.runId)).resolves.toMatchObject({
      status: "completed",
    });
  });

  it.each(["exit-first", "seal-first", "no-exit-proof"])(
    "recovers cancellation failure only after exit and seal (%s)",
    async (order) => {
      const project = await store.createProject({
        name: `cancel-failure-${order}`,
        source: { kind: "empty" },
      });
      await database
        .updateTable("environment_versions")
        .set({ state: "validated", validated_at: new Date() })
        .where("id", "=", project.environment.environmentVersionId)
        .execute();
      const session = await store.createSession(
        project.projectId,
        project.workspaceId,
        "Cancellation failure",
        "elastic",
      );
      const accepted = await store.acceptTurn(session.sessionId, "cancel-failure-target", {
        prompt: "wait",
      });
      let started!: () => void, interrupt!: () => void;
      const running = new Promise<void>((resolve) => {
        started = resolve;
      });
      const interrupted = new Promise<void>((resolve) => {
        interrupt = resolve;
      });
      let executionIdentity!: Parameters<typeof confirmAgentExit>[1];
      const executor = new RunExecutor({
        database,
        claimOwnerId: "cancel-failure-worker",
        backend: {
          async execute(_request, lifecycle) {
            executionIdentity = _request;
            await lifecycle.started();
            started();
            await interrupted;
            if (order !== "no-exit-proof") lifecycle.executionExited();
            throw new TurnExecutionCancelledError("user_request", false);
          },
        },
      });
      const execution = executor.dispatchRun(accepted.runId);
      await running;
      await store.acceptTurnCancellation(session.sessionId, accepted.turnId, "cancel-failed", {});
      const authority = { async assertCurrent() {}, releaseCurrent: vi.fn(async () => {}) };
      const cancellation = new RunCancellationExecutor({
        database,
        executionAuthority: authority,
        backend: {
          async cancel(_request, lifecycle) {
            await lifecycle.started({ executionReference: "test-cancellation-authority" });
            throw new TurnCancellationBackendError(
              "cleanup_failed",
              "Cleanup was not confirmed",
              false,
            );
          },
        },
      });
      const outcome = await cancellation.dispatchTargetRun(accepted.runId);
      expect(outcome).toMatchObject({
        status: "failed",
        phase: "after_start",
        failureCode: "cleanup_failed",
      });
      expect.soft(authority.releaseCurrent).toHaveBeenCalledOnce();
      const seals = await database
        .selectFrom("outbox")
        .select("payload")
        .where("aggregate_type", "=", "session_terminal_event")
        .where(sql<boolean>`payload #>> '{scope,runId}' = ${accepted.runId}`)
        .execute();
      expect(seals).toHaveLength(1);
      const attemptBefore = await database
        .selectFrom("run_attempts")
        .selectAll()
        .where("run_id", "=", accepted.runId)
        .executeTakeFirstOrThrow();
      expect(attemptBefore.agent_exited_at).toBeNull();
      await expect(
        store.acceptTurn(session.sessionId, "too-early", { prompt: "next" }),
      ).rejects.toMatchObject({ code: "conflict" });
      if (order === "exit-first") {
        interrupt();
        await execution;
        await expect(
          store.acceptTurn(session.sessionId, "still-unsealed", { prompt: "next" }),
        ).rejects.toMatchObject({ code: "conflict" });
      }
      const projector = new ExecutionStreamProjector(database);
      const seal = {
        fact: parseKafkaAcceptedFact(JSON.stringify(seals[0]!.payload)),
        topic: `cancel-failure-${session.sessionId}`,
        partition: 0,
        offset: 0n,
      };
      await projector.project(seal);
      if (order !== "exit-first") {
        await expect(
          store.acceptTurn(session.sessionId, "sealed-but-live", { prompt: "next" }),
        ).rejects.toMatchObject({ code: "conflict" });
        interrupt();
        await execution;
      }
      if (order === "no-exit-proof") {
        // A terminal task and expired claim do not attest physical loop exit.
        await database
          .updateTable("run_attempts")
          .set({
            claimed_at: new Date(Date.now() - 120_000),
            claim_expires_at: new Date(Date.now() - 60_000),
          })
          .where("run_id", "=", accepted.runId)
          .execute();
        await expect(
          store.acceptTurn(session.sessionId, "expired-is-not-exited", { prompt: "next" }),
        ).rejects.toMatchObject({ code: "conflict" });
        await confirmAgentExit(database, { ...executionIdentity, tenantId: crypto.randomUUID() });
        await expect(
          store.acceptTurn(session.sessionId, "foreign-proof", { prompt: "next" }),
        ).rejects.toMatchObject({ code: "conflict" });
        // Represents the exact owner-stop confirmation, not an unavailable endpoint.
        await confirmAgentExit(database, executionIdentity);
      }
      const next = await store.acceptTurn(session.sessionId, "next-after-recovery", {
        prompt: "next",
      });
      expect(next.runId).not.toBe(accepted.runId);
      expect(next.sessionId).toBe(session.sessionId);
      await projector.project(seal);
      await confirmAgentExit(database, executionIdentity);
      expect(
        (await store.acceptTurn(session.sessionId, "next-after-recovery", { prompt: "next" }))
          .runId,
      ).toBe(next.runId);
      expect(
        await database
          .selectFrom("runs")
          .select("state")
          .where("id", "=", accepted.runId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: "failed" });
      const terminal = await database
        .selectFrom("session_terminal_events")
        .select("type")
        .where("run_id", "=", accepted.runId)
        .executeTakeFirstOrThrow();
      expect(terminal.type).toBe("turn.failed");
      // A late confirmation from an earlier failure cannot unlock a newer quarantine.
      const failing = new RunExecutor({
        database,
        claimOwnerId: "next-worker",
        backend: {
          async execute(_request, lifecycle) {
            await lifecycle.started();
            throw new TurnExecutionBackendError(
              "new_failure",
              "New execution exit unconfirmed",
              false,
              true,
            );
          },
        },
      });
      expect(await failing.dispatchRun(next.runId)).toMatchObject({ status: "failed" });
      const nextSeal = await database
        .selectFrom("outbox")
        .select("payload")
        .where("aggregate_type", "=", "session_terminal_event")
        .where(sql<boolean>`payload #>> '{scope,runId}' = ${next.runId}`)
        .executeTakeFirstOrThrow();
      await projector.project({
        ...seal,
        fact: parseKafkaAcceptedFact(JSON.stringify(nextSeal.payload)),
        offset: 1n,
      });
      await confirmAgentExit(database, executionIdentity);
      await expect(
        store.acceptTurn(session.sessionId, "stale-proof", { prompt: "next" }),
      ).rejects.toMatchObject({ code: "conflict" });
    },
  );

  it("retries a rolled-back terminal commit without re-executing the Agent Loop", async () => {
    const project = await store.createProject({
      name: "terminal-retry",
      source: { kind: "empty" },
    });
    await database
      .updateTable("environment_versions")
      .set({ state: "validated", validated_at: new Date() })
      .where("id", "=", project.environment.environmentVersionId)
      .execute();
    const session = await store.createSession(
      project.projectId,
      project.workspaceId,
      "terminal-retry",
      "elastic",
    );
    const accepted = await store.acceptTurn(session.sessionId, "terminal-retry", {
      prompt: "one model execution",
    });
    let fail = true,
      executions = 0;
    const measured = database.withPlugin({
      transformQuery({ node, queryId }) {
        const query = database.getExecutor().compileQuery(node, queryId);
        if (
          fail &&
          query.sql.startsWith('update "runs"') &&
          query.parameters.includes("completed")
        ) {
          fail = false;
          throw Object.assign(new Error("injected SQL rollback"), { code: "40P01" });
        }
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    const executor = new RunExecutor({
      database: measured,
      claimOwnerId: "retry-worker",
      backend: {
        async execute(_request, lifecycle) {
          executions++;
          await lifecycle.started();
          return { stopReason: "stop" };
        },
      },
    });
    expect(await executor.dispatchRun(accepted.runId)).toMatchObject({ status: "completed" });
    expect(executions).toBe(1);
    expect(fail).toBe(false);
    expect(
      await database
        .selectFrom("run_attempts")
        .select("id")
        .where("run_id", "=", accepted.runId)
        .execute(),
    ).toHaveLength(1);
    expect(
      await database
        .selectFrom("outbox")
        .select("id")
        .where(sql<boolean>`payload #>> '{scope,runId}' = ${accepted.runId}`)
        .execute(),
    ).toHaveLength(1);
  });
  it("uses Run as the sole idempotent mailbox and serializes one Session", async () => {
    const project = await store.createProject({ name: "queue", source: { kind: "empty" } });
    await database
      .updateTable("environment_versions")
      .set({ state: "validated", validated_at: new Date() })
      .where("id", "=", project.environment.environmentVersionId)
      .executeTakeFirstOrThrow();
    const session = await store.createSession(
      project.projectId,
      project.workspaceId,
      "Run queue",
      "elastic",
    );
    const first = await store.acceptTurn(session.sessionId, "first", { prompt: "first" });
    const replay = await store.acceptTurn(session.sessionId, "first", { prompt: "first" });
    const second = await store.acceptTurn(session.sessionId, "second", { prompt: "second" });

    expect(replay).toMatchObject({ runId: first.runId, replayed: true });
    expect([first.mailboxPosition, second.mailboxPosition]).toEqual([1, 2]);
    await expect(
      database
        .selectFrom("runs")
        .select(["id", "state", "mailbox_position"])
        .where("session_id", "=", session.sessionId)
        .orderBy("mailbox_position")
        .execute(),
    ).resolves.toEqual([
      { id: first.runId, state: "queued", mailbox_position: "1" },
      { id: second.runId, state: "queued", mailbox_position: "2" },
    ]);
    const retiredTable = await sql<{ count: string }>`
      select count(*)::text as count
        from information_schema.tables
       where table_schema = 'public' and table_name = 'commands'
    `.execute(database);
    expect(retiredTable.rows[0]?.count).toBe("0");

    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    let releaseFirst!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const executor = new RunExecutor({
      database,
      claimOwnerId: "run-queue-test-worker",
      backend: {
        async execute(request, lifecycle) {
          await lifecycle.started();
          if (request.runId === first.runId) {
            firstStarted();
            await release;
          }
          return { stopReason: "stop" };
        },
      },
    });

    const firstExecution = executor.dispatchNext();
    await started;
    await expect(executor.dispatchNext()).resolves.toEqual({ status: "idle" });
    releaseFirst();
    await expect(firstExecution).resolves.toMatchObject({
      status: "completed",
      runId: first.runId,
    });
    // Business completion is not the output handoff boundary.
    await expect(executor.dispatchNext()).resolves.toEqual({ status: "idle" });
    const seal = await database
      .selectFrom("outbox")
      .select("payload")
      .where("aggregate_type", "=", "session_terminal_event")
      .where(sql<boolean>`payload #>> '{scope,runId}' = ${first.runId}`)
      .executeTakeFirstOrThrow();
    await new ExecutionStreamProjector(database).project({
      fact: parseKafkaAcceptedFact(JSON.stringify(seal.payload)),
      topic: "queue-seal-test",
      partition: 0,
      offset: 0n,
    });
    await expect(executor.dispatchNext()).resolves.toMatchObject({
      status: "completed",
      runId: second.runId,
    });
  });

  it("persists cancellation as a typed control request without a queue Outbox", async () => {
    const project = await store.createProject({ name: "cancel", source: { kind: "empty" } });
    await database
      .updateTable("environment_versions")
      .set({ state: "validated", validated_at: new Date() })
      .where("id", "=", project.environment.environmentVersionId)
      .executeTakeFirstOrThrow();
    const session = await store.createSession(
      project.projectId,
      project.workspaceId,
      "Cancellation",
      "elastic",
    );
    const accepted = await store.acceptTurn(session.sessionId, "cancel-target", {
      prompt: "wait",
    });

    let started!: () => void;
    const running = new Promise<void>((resolve) => {
      started = resolve;
    });
    let interrupt!: () => void;
    const interrupted = new Promise<void>((resolve) => {
      interrupt = resolve;
    });
    const executor = new RunExecutor({
      database,
      claimOwnerId: "cancellation-test-worker",
      backend: {
        async execute(_request, lifecycle) {
          await lifecycle.started();
          started();
          await interrupted;
          throw new TurnExecutionCancelledError("user_request", false);
        },
      },
    });
    const execution = executor.dispatchRun(accepted.runId);
    await running;
    const cancellation = await store.acceptTurnCancellation(
      session.sessionId,
      accepted.turnId,
      "cancel-request",
      {},
    );
    const authority = {
      async assertCurrent() {},
      async releaseCurrent() {},
    };
    const cancellationExecutor = new RunCancellationExecutor({
      database,
      executionAuthority: authority,
      backend: {
        async cancel(request, lifecycle) {
          await lifecycle.started({ executionReference: "test-cancellation-authority" });
          interrupt();
          return { reason: request.reason, forced: false };
        },
      },
    });
    const [cancelled, interruptedRun] = await Promise.all([
      cancellationExecutor.dispatchTargetRun(accepted.runId),
      execution,
    ]);
    expect(cancelled).toMatchObject({
      status: "cancelled",
      controlRequestId: cancellation.controlRequestId,
      targetRunId: accepted.runId,
    });
    expect(["cancelled", "cancellation_pending"]).toContain(interruptedRun.status);
    await expect(
      store.acceptTurnCancellation(session.sessionId, accepted.turnId, "cancel-request", {}),
    ).resolves.toMatchObject({
      controlRequestId: cancellation.controlRequestId,
      targetRunId: accepted.runId,
      replayed: true,
    });
    await expect(
      database
        .selectFrom("turn_control_requests")
        .select(["state", "target_run_id"])
        .where("id", "=", cancellation.controlRequestId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ state: "completed", target_run_id: accepted.runId });
    await expect(
      database
        .selectFrom("outbox")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where(sql<boolean>`payload #>> '{scope,sessionId}' = ${session.sessionId}`)
        .where("outbox.topic", "=", "session.event.accepted.v1")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: "1" });
  });

  it("lets competing Workers claim different ready Runs without a candidate scan", async () => {
    const project = await store.createProject({ name: "competing", source: { kind: "empty" } });
    await database
      .updateTable("environment_versions")
      .set({ state: "validated", validated_at: new Date() })
      .where("id", "=", project.environment.environmentVersionId)
      .executeTakeFirstOrThrow();
    const [leftSession, rightSession] = await Promise.all([
      store.createSession(project.projectId, project.workspaceId, "Left", "elastic"),
      store.createSession(project.projectId, project.workspaceId, "Right", "elastic"),
    ]);
    const [left, right] = await Promise.all([
      store.acceptTurn(leftSession.sessionId, "left", { prompt: "left" }),
      store.acceptTurn(rightSession.sessionId, "right", { prompt: "right" }),
    ]);
    const observed = new Set<string>();
    const backend: TurnExecutionBackend = {
      async execute(request, lifecycle) {
        await lifecycle.started();
        observed.add(request.runId);
        return { stopReason: "stop" };
      },
    };
    const firstWorker = new RunExecutor({
      database,
      claimOwnerId: "competing-worker-1",
      backend,
    });
    const secondWorker = new RunExecutor({
      database,
      claimOwnerId: "competing-worker-2",
      backend,
    });
    const results = await Promise.all([firstWorker.dispatchNext(), secondWorker.dispatchNext()]);
    expect(results.every((result) => result.status === "completed")).toBe(true);
    expect(observed).toEqual(new Set([left.runId, right.runId]));
  });

  it("keeps every active Lane of one physical Pi Session on its owner Worker", async () => {
    const project = await store.createProject({ name: "lane-owner", source: { kind: "empty" } });
    await database
      .updateTable("environment_versions")
      .set({ state: "validated", validated_at: new Date() })
      .where("id", "=", project.environment.environmentVersionId)
      .executeTakeFirstOrThrow();
    const [rootSession, childScope] = await Promise.all([
      store.createSession(project.projectId, project.workspaceId, "Lane owner", "elastic"),
      store.createSession(project.projectId, project.workspaceId, "Child scope", "elastic"),
    ]);
    const [root, child] = await Promise.all([
      store.acceptTurn(rootSession.sessionId, "lane-owner-root", { prompt: "parent" }),
      store.acceptTurn(childScope.sessionId, "lane-owner-child", { prompt: "child" }),
    ]);
    const childLane = `subagent-${globalThis.crypto.randomUUID()}`;
    await database.transaction().execute(async (transaction) => {
      await transaction
        .insertInto("pi_session_lanes")
        .values({
          tenant_id: tenantId,
          session_id: rootSession.sessionId,
          lane: childLane,
          leaf_id: null,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("sessions")
        .set({
          pi_session_id: rootSession.sessionId,
          pi_session_lane: childLane,
          session_kind: "subagent",
        })
        .where("id", "=", childScope.sessionId)
        .executeTakeFirstOrThrow();
    });

    let parentStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      parentStarted = resolve;
    });
    let releaseParent!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseParent = resolve;
    });
    const observed: string[] = [];
    const owner = new RunExecutor({
      database,
      claimOwnerId: "pi-session-owner-worker",
      backend: {
        async execute(request, lifecycle) {
          await lifecycle.started();
          observed.push(request.runId);
          if (request.runId === root.runId) {
            parentStarted();
            await release;
          }
          return { stopReason: "stop" };
        },
      },
    });
    const other = new RunExecutor({
      database,
      claimOwnerId: "other-worker",
      backend: {
        async execute() {
          throw new Error("Another Worker must not execute a Lane in the owned Pi Session");
        },
      },
    });

    const parentExecution = owner.dispatchRun(root.runId);
    await started;
    await expect(other.dispatchRun(child.runId)).resolves.toEqual({ status: "idle" });
    await expect(owner.dispatchRun(child.runId)).resolves.toMatchObject({
      status: "completed",
      runId: child.runId,
    });
    releaseParent();
    await expect(parentExecution).resolves.toMatchObject({
      status: "completed",
      runId: root.runId,
    });
    expect(observed).toEqual([root.runId, child.runId]);
    const rootSeal = await database
      .selectFrom("outbox")
      .select("payload")
      .where(sql<boolean>`payload #>> '{scope,runId}' = ${root.runId}`)
      .executeTakeFirstOrThrow();
    await new ExecutionStreamProjector(database).project({
      fact: parseKafkaAcceptedFact(JSON.stringify(rootSeal.payload)),
      topic: "lane-seal-test",
      partition: 0,
      offset: 0n,
    });
    const childSeal = await database
      .selectFrom("outbox")
      .select("payload")
      .where(sql<boolean>`payload #>> '{scope,runId}' = ${child.runId}`)
      .executeTakeFirstOrThrow();
    await new ExecutionStreamProjector(database).project({
      fact: parseKafkaAcceptedFact(JSON.stringify(childSeal.payload)),
      topic: "lane-seal-test",
      partition: 0,
      offset: 1n,
    });

    const later = await store.acceptTurn(rootSession.sessionId, "lane-owner-later", {
      prompt: "later",
    });
    const replacement = new RunExecutor({
      database,
      claimOwnerId: "replacement-worker",
      backend: {
        async execute(request, lifecycle) {
          expect(request.piSessionId).toBe(rootSession.sessionId);
          await lifecycle.started();
          return { stopReason: "stop" };
        },
      },
    });
    await expect(replacement.dispatchRun(later.runId)).resolves.toMatchObject({
      status: "completed",
      runId: later.runId,
    });
  });

  it("atomically elects one Worker when two Lanes of a cold Pi Session race", async () => {
    const project = await store.createProject({ name: "lane-race", source: { kind: "empty" } });
    await database
      .updateTable("environment_versions")
      .set({ state: "validated", validated_at: new Date() })
      .where("id", "=", project.environment.environmentVersionId)
      .executeTakeFirstOrThrow();
    const [leftScope, rightScope] = await Promise.all([
      store.createSession(project.projectId, project.workspaceId, "Left lane", "elastic"),
      store.createSession(project.projectId, project.workspaceId, "Right lane", "elastic"),
    ]);
    const [left, right] = await Promise.all([
      store.acceptTurn(leftScope.sessionId, "lane-race-left", { prompt: "left" }),
      store.acceptTurn(rightScope.sessionId, "lane-race-right", { prompt: "right" }),
    ]);
    const rightLane = `subagent-${globalThis.crypto.randomUUID()}`;
    await database.transaction().execute(async (transaction) => {
      await transaction
        .insertInto("pi_session_lanes")
        .values({
          tenant_id: tenantId,
          session_id: leftScope.sessionId,
          lane: rightLane,
          leaf_id: null,
        })
        .executeTakeFirstOrThrow();
      await transaction
        .updateTable("sessions")
        .set({
          pi_session_id: leftScope.sessionId,
          pi_session_lane: rightLane,
          session_kind: "subagent",
        })
        .where("id", "=", rightScope.sessionId)
        .executeTakeFirstOrThrow();
    });

    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    let releaseWinner!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    const owners: string[] = [];
    const executor = (owner: string) =>
      new RunExecutor({
        database,
        claimOwnerId: owner,
        backend: {
          async execute(_request, lifecycle) {
            await lifecycle.started();
            owners.push(owner);
            notifyStarted();
            await release;
            return { stopReason: "stop" };
          },
        },
      });
    const leftExecution = executor("lane-race-worker-left").dispatchRun(left.runId);
    const rightExecution = executor("lane-race-worker-right").dispatchRun(right.runId);
    await started;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
    releaseWinner();
    const results = await Promise.all([leftExecution, rightExecution]);

    expect(results.filter((result) => result.status === "completed")).toHaveLength(1);
    expect(results.filter((result) => result.status === "idle")).toHaveLength(1);
    expect(owners).toHaveLength(1);
  });
});
