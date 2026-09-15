import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { SessionLeaseCoordinator } from "@pi-cloud/runtime-core/session-lease-coordinator";
import { RunExecutor, type TurnExecutionRequest } from "@pi-cloud/runtime-core/run-executor";
import { ExecutionStreamProjector, type AcceptedFact } from "@pi-cloud/runtime-core";
import { parseExecutionReference } from "@pi-cloud/protocol";
import { it, expect } from "vitest";
import { ControlPlaneStore, createPrivateTenant } from "../src/index.ts";
import { AssignmentReconciler } from "../src/assignment-reconciler.ts";

async function fixture(capacity = 1, leaseMs = 60000) {
  const pg = await PGlite.create(),
    socket = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0 });
  await socket.start();
  const db = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 1,
  });
  await runMigrations(db, "up");
  const tenant = await createPrivateTenant(db, { slug: "family-lease", ownerDisplayName: "test" });
  const store = new ControlPlaneStore({
    database: db,
    tenantId: tenant.tenantId,
    defaultModelProfileId: tenant.defaultModelProfileId,
  });
  const project = await store.createProject({ name: "family", source: { kind: "empty" } });
  await db
    .updateTable("environment_versions")
    .set({ state: "validated", validated_at: new Date() })
    .where("id", "=", project.environment.environmentVersionId)
    .execute();
  const main = await store.createSession(project.projectId, project.workspaceId, "main", "elastic");
  const child = await store.createSession(
    project.projectId,
    project.workspaceId,
    "child",
    "elastic",
  );
  const foreign = await store.createSession(
    project.projectId,
    project.workspaceId,
    "foreign",
    "elastic",
  );
  await db
    .insertInto("pi_session_lanes")
    .values({
      tenant_id: tenant.tenantId,
      session_id: main.sessionId,
      lane: "child",
      leaf_id: null,
    })
    .execute();
  await db
    .updateTable("sessions")
    .set({ pi_session_id: main.sessionId, pi_session_lane: "child" })
    .where("id", "=", child.sessionId)
    .execute();
  const workerId = crypto.randomUUID();
  await db
    .insertInto("sandboxes")
    .values({
      id: workerId,
      supervisor_id: "family-worker",
      boot_id: crypto.randomUUID(),
      state: "ready",
      max_concurrent_sessions: capacity,
      active_sessions: 0,
    })
    .execute();
  const coordinator = new SessionLeaseCoordinator({
    database: db,
    sandboxId: workerId,
    leaseDurationMs: leaseMs,
  });
  const tasks = new Map<
    string,
    { request: TurnExecutionRequest; reference: string; release: () => void }
  >();
  const ready = new Map<string, () => void>();
  const running: Promise<unknown>[] = [];
  const executor = new RunExecutor({
    database: db,
    claimOwnerId: "family-worker",
    executionAuthority: coordinator,
    backend: {
      execute: async (request, lifecycle) => {
        const binding = await coordinator.acquire(request);
        await lifecycle.started(binding);
        const wait = new Promise<void>((release) =>
          tasks.set(request.runId, { request, reference: binding.executionReference, release }),
        );
        ready.get(request.runId)?.();
        await wait;
        return { stopReason: "stop" };
      },
    },
  });
  async function start(sessionId: string) {
    const run = await store.acceptTurn(sessionId, crypto.randomUUID(), { prompt: "test" });
    const started = new Promise<void>((r) => ready.set(run.runId, r));
    const done = executor.dispatchRun(run.runId);
    running.push(done);
    void done.catch(() => {});
    await Promise.race([
      started,
      done.then((result) => {
        throw new Error(`Unexpected early completion ${JSON.stringify(result)}`);
      }),
    ]);
    return { run, done, ...tasks.get(run.runId)! };
  }
  async function renew() {
    const leases = await db.selectFrom("session_leases").selectAll().execute();
    const identity = await coordinator.heartbeatIdentity();
    return coordinator.renewFromHeartbeat({
      protocolVersion: 1,
      messageId: crypto.randomUUID(),
      sentAt: new Date().toISOString(),
      type: "supervisor.heartbeat",
      payload: {
        ...identity,
        maxConcurrentSessions: capacity,
        acceptingAssignments: true,
        families: leases.map((l) => ({
          tenantId: l.tenant_id,
          piSessionId: l.pi_session_id,
          leaseId: l.lease_id,
          writerId: l.writer_id,
          fencingToken: Number(l.fencing_token),
        })),
      },
    });
  }
  async function projectSeals() {
    const records = await db
      .selectFrom("outbox")
      .select("payload")
      .where("aggregate_type", "=", "session_terminal_event")
      .orderBy("created_at")
      .execute();
    const projector = new ExecutionStreamProjector(db);
    let offset = 0n;
    for (const row of records)
      await projector.project({
        fact: row.payload as unknown as AcceptedFact,
        topic: "family-test",
        partition: 0,
        offset: offset++,
      });
  }
  return {
    db,
    store,
    main,
    child,
    foreign,
    workerId,
    coordinator,
    executor,
    start,
    renew,
    projectSeals,
    close: async () => {
      for (const task of tasks.values()) task.release();
      await Promise.allSettled(running);
      await db.destroy();
      await socket.stop();
      await pg.close();
    },
  };
}

it("shares one owner lease, renews once, and releases capacity only after the final task", async () => {
  const f = await fixture();
  try {
    const main = await f.start(f.main.sessionId),
      child = await f.start(f.child.sessionId);
    const a = parseExecutionReference(main.reference),
      b = parseExecutionReference(child.reference);
    expect(a.leaseId).toBe(b.leaseId);
    expect(a.fencingToken).toBe(b.fencingToken);
    expect(a.attemptId).not.toBe(b.attemptId);
    expect(await f.db.selectFrom("session_leases").selectAll().execute()).toHaveLength(1);
    expect(await f.db.selectFrom("active_execution_scopes").selectAll().execute()).toHaveLength(2);
    // A child has made no progress and its old startup claim date is past.
    const past = new Date(Date.now() - 1);
    await f.db
      .updateTable("run_attempts")
      .set({ claim_expires_at: past })
      .where("id", "=", b.attemptId)
      .execute();
    expect((await f.renew()).payload.familyLeaseRenewals).toHaveLength(1);
    expect(
      (
        await f.db
          .selectFrom("run_attempts")
          .select("claim_expires_at")
          .where("id", "=", b.attemptId)
          .executeTakeFirstOrThrow()
      ).claim_expires_at,
    ).toEqual(past);
    await f.coordinator.assertCurrentGrant(child.request, { executionReference: child.reference });
    const foreign = await f.store.acceptTurn(f.foreign.sessionId, "blocked", { prompt: "blocked" });
    expect(await f.executor.dispatchRun(foreign.runId)).toMatchObject({
      status: "retry_scheduled",
      failureCode: "capacity",
    });
    main.release();
    expect(await main.done).toMatchObject({ status: "completed" });
    expect(await f.db.selectFrom("session_leases").selectAll().execute()).toHaveLength(1);
    await expect(
      f.coordinator.assertCurrentGrant(main.request, { executionReference: main.reference }),
    ).rejects.toThrow();
    expect((await f.renew()).payload.familyLeaseRenewals).toHaveLength(1);
    await f.coordinator.assertCurrentGrant(child.request, { executionReference: child.reference });
    child.release();
    expect(await child.done).toMatchObject({ status: "completed" });
    expect(await f.db.selectFrom("session_leases").selectAll().execute()).toHaveLength(0);
    expect(
      (
        await f.db
          .selectFrom("sandboxes")
          .select("active_sessions")
          .where("id", "=", f.workerId)
          .executeTakeFirstOrThrow()
      ).active_sessions,
    ).toBe(0);
    await f.projectSeals();
    const next = await f.start(f.main.sessionId);
    expect(parseExecutionReference(next.reference).fencingToken).toBe(a.fencingToken + 1);
    expect(parseExecutionReference(next.reference).leaseId).not.toBe(a.leaseId);
    next.release();
    await next.done;
  } finally {
    await f.close();
  }
}, 30000);

it("retires every task of an expired Session, even with a one-family recovery limit", async () => {
  const f = await fixture(2);
  try {
    const main = await f.start(f.main.sessionId),
      child = await f.start(f.child.sessionId);
    const other = await f.start(f.foreign.sessionId);
    await f.db
      .updateTable("session_leases")
      .set({ valid_until: new Date(Date.now() - 1) })
      .where("pi_session_id", "=", f.main.sessionId)
      .execute();
    const reconciler = new AssignmentReconciler({
      database: f.db,
      sandboxId: f.workerId,
      inventory: {
        listAssignments: async () => {
          throw new Error("Semantic retirement must not kill a healthy Worker");
        },
        terminateAndConfirmAbsent: async () => {
          throw new Error("Unexpected physical termination");
        },
      },
    });
    expect(await reconciler.retireExpiredAssignments(1)).toMatchObject({ settledAssignments: 2 });
    expect(await f.db.selectFrom("session_leases").select("pi_session_id").execute()).toEqual([
      { pi_session_id: f.foreign.sessionId },
    ]);
    await expect(
      f.coordinator.assertCurrentGrant(child.request, { executionReference: child.reference }),
    ).rejects.toThrow();
    await f.coordinator.assertCurrentGrant(other.request, { executionReference: other.reference });
    await f.projectSeals();
    main.release();
    child.release();
    other.release();
    await Promise.allSettled([main.done, child.done, other.done]);
  } finally {
    await f.close();
  }
}, 30000);
