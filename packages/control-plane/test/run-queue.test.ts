import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { RunExecutor, type TurnExecutionBackend } from "@pi-cloud/runtime-core/run-executor";
import { TurnExecutionCancelledError } from "@pi-cloud/runtime-core/run-executor";
import { RunCancellationExecutor } from "@pi-cloud/runtime-core/run-cancellation-executor";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ControlPlaneStore, createPrivateTenant } from "../src/index.ts";

let pglite: PGlite;
let socket: PGLiteSocketServer;
let database: Kysely<Database>;
let store: ControlPlaneStore;
let tenantId: string;

beforeAll(async () => {
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
});

describe.sequential("Run queue authority", () => {
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

    const firstExecution = executor.dispatchNext("conversation");
    await started;
    await expect(executor.dispatchNext("conversation")).resolves.toEqual({ status: "idle" });
    releaseFirst();
    await expect(firstExecution).resolves.toMatchObject({
      status: "completed",
      runId: first.runId,
    });
    await expect(executor.dispatchNext("conversation")).resolves.toMatchObject({
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
          await lifecycle.started({ executionLease: "test-cancellation-authority" });
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
        .innerJoin("session_terminal_events as terminal", "terminal.event_id", "outbox.id")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("terminal.session_id", "=", session.sessionId)
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
    const results = await Promise.all([
      firstWorker.dispatchNext("conversation"),
      secondWorker.dispatchNext("conversation"),
    ]);
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
