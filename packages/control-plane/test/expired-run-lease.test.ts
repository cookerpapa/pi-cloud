import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { SessionLeaseCoordinator } from "@pi-cloud/runtime-core/session-lease-coordinator";
import { RunExecutor } from "@pi-cloud/runtime-core/run-executor";
import { ExecutionStreamProjector, type AcceptedFact } from "@pi-cloud/runtime-core";
import { expect, it } from "vitest";
import { ControlPlaneStore, createPrivateTenant } from "../src/index.ts";
import { AssignmentReconciler } from "../src/assignment-reconciler.ts";

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
      .insertInto("sandboxes")
      .values({
        id: workerId,
        supervisor_id: "expiry-worker",
        boot_id: crypto.randomUUID(),
        state: "ready",
        max_concurrent_sessions: 8,
        active_sessions: 0,
      })
      .execute();
    let now = Date.now();
    const clock = () => new Date(now),
      coordinator = new SessionLeaseCoordinator({
        database: db,
        sandboxId: workerId,
        clock,
        leaseDurationMs: 1000,
      });
    const released = new Map<string, () => void>(),
      started = new Map<string, () => void>();
    const ready = (id: string) => new Promise<void>((r) => started.set(id, r));
    const executor = new RunExecutor({
      database: db,
      claimOwnerId: "expiry-worker",
      clock,
      executionAuthority: coordinator,
      backend: {
        async execute(request, lifecycle) {
          const lease = await coordinator.acquire(request);
          await lifecycle.started(lease);
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
      sandboxId: workerId,
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
    expect(await reconciler.retireExpiredAssignments()).toMatchObject({
      settledAssignments: 1,
      terminatedRuntimes: 0,
    });
    expect(
      await db
        .selectFrom("sandboxes")
        .select(["state", "active_sessions"])
        .where("id", "=", workerId)
        .executeTakeFirst(),
    ).toEqual({ state: "leased", active_sessions: 1 });
    expect(
      await db
        .selectFrom("session_leases")
        .select("session_id")
        .where("sandbox_id", "=", workerId)
        .execute(),
    ).toEqual([{ session_id: b.sessionId }]);
    expect(await store.getRun(first.runId)).toMatchObject({ state: "settling" });
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
    expect(await store.getRun(first.runId)).toMatchObject({ state: "failed" });
    released.get(first.runId)!();
    released.get(second.runId)!();
    await firstRun;
    expect(await secondRun).toMatchObject({ status: "completed" });
  } finally {
    await db.destroy();
    await socket.stop();
    await pg.close();
  }
}, 30000);
