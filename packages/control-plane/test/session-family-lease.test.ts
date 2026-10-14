import { registerTestWorker } from "./fixtures/registered-worker.ts";
import { admitTestExecution } from "./admit-test-execution.ts";
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
import { PiCloudMetrics } from "@pi-cloud/observability";

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
  const foreign = await store.createSession(
    project.projectId,
    project.workspaceId,
    "foreign",
    "elastic",
  );
  const workerId = crypto.randomUUID();
  await db
    .insertInto("workers")
    .values({
      id: workerId,
      supervisor_id: "family-worker",
      boot_id: crypto.randomUUID(),
      state: "ready",
      max_concurrent_sessions: capacity,
    })
    .execute();
  await registerTestWorker(db, workerId);
  const metrics = new PiCloudMetrics("lease-timing-test");
  const coordinator = new SessionLeaseCoordinator({
    database: db,
    workerId: workerId,
    leaseDurationMs: leaseMs,
  });
  const tasks = new Map<
    string,
    { request: TurnExecutionRequest; reference: string; release: () => void }
  >();
  const ready = new Map<string, () => void>();
  const running: Promise<unknown>[] = [];
  const completions: AcceptedFact[] = [];
  const executor = new RunExecutor({
    database: db,
    workerId,
    executionAuthority: coordinator,
    backend: {
      admit: (tx, request, _mark, facts) => admitTestExecution(coordinator, tx, request, facts),
      execute: async (request, lifecycle, admission) => {
        const binding = admission!;
        lifecycle.publicationReady({
          close: async () => {},
          finish: async (terminal) => {
            const ref = parseExecutionReference(binding.executionReference);
            const owner = await db
              .selectFrom("session_leases")
              .select("writer_sealed_at")
              .where("lease_id", "=", ref.leaseId)
              .executeTakeFirstOrThrow();
            if (owner.writer_sealed_at !== null) throw new Error("Writer was fenced");
            const {
              leaseId: _lease,
              piConversationId: _conversation,
              ...scope
            } = admission.publication.scope;
            completions.push({
              kind: "work_finished",
              scope,
              factId: crypto.randomUUID(),
              agentId: "root",
              baseSequence: 0,
              nativeSequence: 0,
              terminal,
              retireWriter: true,
              occurredAt: new Date().toISOString(),
            });
          },
        });

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
    const leases = await db
      .selectFrom("session_leases")
      .selectAll()
      .where("released_at", "is", null)
      .execute();
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
          writerId: l.lease_id,
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
    for (const fact of [
      ...completions,
      ...records.map((row) => row.payload as unknown as AcceptedFact),
    ])
      await projector.project({
        fact,
        topic: "family-test",
        partition: 0,
        offset: offset++,
      });
  }
  return {
    db,
    store,
    main,
    foreign,
    workerId,
    coordinator,
    metrics,
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

it("renews one Session owner and releases it only after ordered work completion", async () => {
  const f = await fixture();
  try {
    const main = await f.start(f.main.sessionId),
      a = parseExecutionReference(main.reference);
    expect(await f.db.selectFrom("session_leases").selectAll().execute()).toHaveLength(1);
    expect(await f.db.selectFrom("active_execution_scopes").selectAll().execute()).toHaveLength(1);
    const past = new Date(Date.now() - 120_000);
    await f.db.updateTable("runs").set({ updated_at: past }).where("id", "=", a.runId).execute();
    expect((await f.renew()).payload.familyLeaseRenewals).toHaveLength(1);
    expect(
      (
        await f.db
          .selectFrom("runs")
          .select("updated_at")
          .where("id", "=", a.runId)
          .executeTakeFirstOrThrow()
      ).updated_at,
    ).toEqual(past);
    main.release();
    await main.done;
    expect(
      await f.db
        .selectFrom("session_leases")
        .select("lease_id")
        .where("released_at", "is", null)
        .execute(),
    ).toHaveLength(1);
    await f.projectSeals();
    expect(
      await f.db
        .selectFrom("session_leases")
        .select("lease_id")
        .where("released_at", "is", null)
        .execute(),
    ).toHaveLength(0);
    await expect(
      f.coordinator.assertCurrentGrant(main.request, { executionReference: main.reference }),
    ).rejects.toThrow();
    const next = await f.start(f.main.sessionId);
    expect(parseExecutionReference(next.reference).fencingToken).toBe(a.fencingToken + 1);
    next.release();
    await next.done;
  } finally {
    await f.close();
  }
}, 30_000);

it("closes one expired Session writer without retiring another physical Session", async () => {
  const f = await fixture(2);
  try {
    const main = await f.start(f.main.sessionId),
      other = await f.start(f.foreign.sessionId);
    await f.db
      .updateTable("session_leases")
      .set({ valid_until: new Date(Date.now() - 1) })
      .where("pi_session_id", "=", f.main.sessionId)
      .execute();
    const reconciler = new AssignmentReconciler({
      database: f.db,
      workerId: f.workerId,
      inventory: {
        listAssignments: async () => {
          throw new Error("Lease retirement must not terminate the Worker");
        },
        terminateAndConfirmAbsent: async () => {
          throw new Error("Unexpected physical termination");
        },
      },
    });
    expect(await reconciler.retireExpiredAssignments(1)).toMatchObject({ settledAssignments: 1 });
    // Revocation precedes the ordered closure; retained ownership blocks takeover.
    expect(
      await f.db
        .selectFrom("session_leases")
        .select("lease_id")
        .where("released_at", "is", null)
        .execute(),
    ).toHaveLength(2);
    await expect(
      f.coordinator.assertCurrentGrant(main.request, { executionReference: main.reference }),
    ).rejects.toThrow();
    await f.coordinator.assertCurrentGrant(other.request, { executionReference: other.reference });
    await f.projectSeals();
    expect(
      await f.db
        .selectFrom("session_leases")
        .select("pi_session_id")
        .where("released_at", "is", null)
        .execute(),
    ).toEqual([{ pi_session_id: f.foreign.sessionId }]);
    main.release();
    other.release();
    await Promise.allSettled([main.done, other.done]);
  } finally {
    await f.close();
  }
}, 30_000);
