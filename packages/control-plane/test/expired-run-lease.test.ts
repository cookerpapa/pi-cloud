import { registerTestWorker } from "./fixtures/registered-worker.ts";
import { admitTestExecution, testWorkPublication } from "./admit-test-execution.ts";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { SessionLeaseCoordinator } from "@pi-cloud/runtime-core/session-lease-coordinator";
import { RunExecutor } from "@pi-cloud/runtime-core/run-executor";
import { ExecutionStreamProjector, type AcceptedFact } from "@pi-cloud/runtime-core";
import { expect, it } from "vitest";
import { ControlPlaneStore, createPrivateTenant } from "../src/index.ts";
import { AssignmentReconciler } from "../src/assignment-reconciler.ts";
import { SupervisorConnectionManager } from "../src/supervisor-connection-manager.ts";

it("retires an expired Run on a healthy Worker without stopping its other Session", async () => {
  const pg = await PGlite.create(),
    socket = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0 });
  await socket.start();
  const db = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 1,
  });
  try {
    await runMigrations(db, "up");
    const tenant = await createPrivateTenant(db, {
      slug: "healthy-worker-expiry",
      ownerDisplayName: "Expiry test",
    });
    const store = new ControlPlaneStore({
      database: db,
      tenantId: tenant.tenantId,
      defaultModelProfileId: tenant.defaultModelProfileId,
    });
    const project = await store.createProject({ name: "expiry", source: { kind: "empty" } });
    await db
      .updateTable("environment_versions")
      .set({ state: "validated", validated_at: new Date() })
      .where("id", "=", project.environment.environmentVersionId)
      .execute();
    const [a, b] = await Promise.all([
      store.createSession(project.projectId, project.workspaceId, "A", "elastic"),
      store.createSession(project.projectId, project.workspaceId, "B", "elastic"),
    ]);
    const first = await store.acceptTurn(a.sessionId, "a", { prompt: "A" }),
      second = await store.acceptTurn(b.sessionId, "b", { prompt: "B" });
    const workerId = crypto.randomUUID();
    await db
      .insertInto("workers")
      .values({
        id: workerId,
        supervisor_id: "expiry-worker",
        boot_id: crypto.randomUUID(),
        state: "ready",
        max_concurrent_sessions: 8,
      })
      .execute();
    await registerTestWorker(db, workerId);
    let now = Date.now();
    const clock = () => new Date(now),
      coordinator = new SessionLeaseCoordinator({
        database: db,
        workerId: workerId,
        clock,
        leaseDurationMs: 60000,
      });
    const released = new Map<string, () => void>(),
      started = new Map<string, () => void>();
    const ready = (id: string) => new Promise<void>((r) => started.set(id, r));
    const executor = new RunExecutor({
      database: db,
      workerId,
      clock,
      executionAuthority: coordinator,
      backend: {
        admit: (tx, request, _mark, facts) => admitTestExecution(coordinator, tx, request, facts),
        async execute(request, lifecycle, admission) {
          lifecycle.publicationReady(testWorkPublication(db, request, admission));
          const wait = new Promise<void>((r) => released.set(request.runId, r));
          started.get(request.runId)!();
          await wait;
          return { stopReason: "stop" };
        },
      },
    });
    const firstReady = ready(first.runId),
      firstRun = executor.dispatchRun(first.runId).catch((error) => error);
    await firstReady;
    now += 500;
    const secondReady = ready(second.runId),
      secondRun = executor.dispatchRun(second.runId);
    await secondReady;
    now += 600;
    const reconciler = new AssignmentReconciler({
      database: db,
      workerId: workerId,
      clock,
      inventory: {
        async listAssignments() {
          throw new Error("Healthy Worker inventory must not be killed or scanned");
        },
        async terminateAndConfirmAbsent() {
          throw new Error("Unrelated runtimes must survive");
        },
      },
    });
    let apiClockSkew = 3_600_000;
    const manager = new SupervisorConnectionManager({
      database: db,
      controlPlaneInstanceId: crypto.randomUUID(),
      clock: () => new Date(Date.now() + apiClockSkew),
      ownerBoundary: {
        async stopAndConfirm() {
          throw new Error("Healthy Worker must survive");
        },
      },
      assignmentRetirerFactory: () => reconciler,
    });
    expect(await manager.sweepExpiredExecutions()).toMatchObject({ expiredAssignments: 0 });
    await db
      .updateTable("session_leases")
      .set({ valid_until: new Date(Date.now() - 1) })
      .where("pi_session_id", "=", a.sessionId)
      .execute();
    apiClockSkew = -3_600_000;
    expect(await manager.sweepExpiredExecutions()).toMatchObject({
      expiredAssignments: 1,
    });
    expect(
      await db
        .selectFrom("workers")
        .select(["state"])
        .where("id", "=", workerId)
        .executeTakeFirst(),
    ).toEqual({ state: "ready" });
    expect(
      await db
        .selectFrom("session_leases")
        .select("pi_session_id")
        .where("worker_id", "=", workerId)
        .where("released_at", "is", null)
        .execute(),
    ).toEqual(
      expect.arrayContaining([{ pi_session_id: a.sessionId }, { pi_session_id: b.sessionId }]),
    );
    expect(await store.getRun(first.runId)).toMatchObject({ state: "running" });
    const row = await db
      .selectFrom("outbox")
      .select("payload")
      .where("aggregate_type", "=", "session_terminal_event")
      .executeTakeFirstOrThrow();
    await new ExecutionStreamProjector(db).project({
      fact: row.payload as unknown as AcceptedFact,
      topic: "expired",
      partition: 0,
      offset: 0n,
    });
    expect(await store.getRun(first.runId)).toMatchObject({ state: "queued" });
    released.get(first.runId)!();
    released.get(second.runId)!();
    expect(await firstRun).toMatchObject({ status: "recovering" });
    expect(await secondRun).toMatchObject({ status: "completed" });
  } finally {
    await db.destroy();
    await socket.stop();
    await pg.close();
  }
}, 30000);
