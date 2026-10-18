// ADR-0259 real-PG expiry/retirement regressions.
// All database work is confined to disposable migrated PostgreSQL databases.
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { sql, type Kysely } from "kysely";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { createTestWorker } from "./admit-test-execution.ts";
import { AssignmentReconciler } from "../src/assignment-reconciler.ts";
import { SupervisorConnectionManager } from "../src/supervisor-connection-manager.ts";
import { ExecutionStreamProjector } from "../../runtime-core/src/execution-stream-projection.ts";
import { WorkerExecutionLog } from "../../runtime-core/src/worker-execution-log.ts";
import { AgentRunExecutionBackend } from "../../supervisor-host/src/agent-run-execution-backend.ts";
import { AgentRunSupervisor, PiTurnCancelledError } from "@pi-cloud/sandbox-supervisor";
import { parseExecutionReference } from "@pi-cloud/protocol";
import type { AcceptedFact } from "../../runtime-core/src/accepted-fact.ts";

const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
describe.skipIf(!endpoint)("Control Plane expiry progress", () => {
  let admin: Kysely<Database>, db: Kysely<Database>, name: string;
  const running: Array<{ release(): void; done: Promise<unknown> }> = [];
  beforeAll(() => {
    admin = createDatabase({ connectionString: endpoint!, maxConnections: 1 });
  });
  beforeEach(async () => {
    name = `pi_expiry_review_${randomUUID().replaceAll("-", "")}`;
    await sql`create database ${sql.id(name)}`.execute(admin);
    const url = new URL(endpoint!);
    url.pathname = `/${name}`;
    url.searchParams.set("application_name", name);
    // Test watchdogs only: the production maintenance pool has no such budget.
    url.searchParams.set(
      "options",
      "-c statement_timeout=10000 -c idle_in_transaction_session_timeout=20000",
    );
    db = createDatabase({ connectionString: url.toString(), maxConnections: 12 });
    await runMigrations(db, "up");
  }, 60000);
  afterEach(async () => {
    for (const task of running) task.release();
    await Promise.allSettled(running.splice(0).map((task) => task.done));
    await db.destroy();
    await vi.waitFor(
      async () => {
        const rows = await sql<{
          n: number;
        }>`select count(*)::int n from pg_stat_activity where datname=${name}`.execute(admin);
        expect(rows.rows[0]!.n).toBe(0);
      },
      { timeout: 5000 },
    );
    await sql`drop database ${sql.id(name)}`.execute(admin);
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    await admin.destroy();
  });

  const inventory = {
    async listAssignments(): Promise<never> {
      throw new Error("This hop must not inventory physical runtimes");
    },
    async terminateAndConfirmAbsent(): Promise<never> {
      throw new Error("This hop must not terminate physical runtimes");
    },
  };
  const manager = (instance: string = randomUUID()) =>
    new SupervisorConnectionManager({
      database: db,
      controlPlaneInstanceId: instance,
      ownerBoundary: {
        async stopAndConfirm() {
          throw new Error("No physical stop in expiry scan");
        },
      },
      assignmentRetirerFactory: (identity) =>
        new AssignmentReconciler({ database: db, workerId: identity.sandboxId, inventory }),
    });
  async function fixture() {
    const tenant = await createPrivateTenant(db, {
      slug: `expiry-review-${randomUUID()}`,
      ownerDisplayName: "Expiry review",
    });
    const store = new ControlPlaneStore({ database: db, ...tenant });
    const project = await store.createProject({ name: "Expiry review", source: { kind: "empty" } });
    const worker = await createTestWorker(db, 128);
    async function start(owner = worker) {
      const session = await store.createSession(
        project.projectId,
        project.workspaceId,
        "Review",
        "elastic",
      );
      const accepted = await store.acceptTurn(session.sessionId, randomUUID(), {
        prompt: "Review only",
      });
      const ready = Promise.withResolvers<string>(),
        finish = Promise.withResolvers<void>();
      const executor = owner.executor({
        async execute(_request, lifecycle, admission) {
          ready.resolve(admission.executionReference);
          await finish.promise;
          lifecycle.executionExited();
          return { stopReason: "stop" };
        },
      });
      const done = executor.dispatchRun(accepted.runId);
      void done.catch(() => {});
      running.push({ release: () => finish.resolve(), done });
      const reference = await Promise.race([
        ready.promise,
        done.then((v) => {
          throw new Error(`Admission did not run: ${JSON.stringify(v)}`);
        }),
      ]);
      return { sessionId: session.sessionId, ...parseExecutionReference(reference) };
    }
    return { tenant, store, project, worker, start };
  }
  const expire = (leaseId: string, ageMs = 1000) =>
    db
      .updateTable("session_leases")
      .set({
        valid_until: sql<Date>`clock_timestamp()-${ageMs}*interval '1 millisecond'`,
        acquired_at: sql<Date>`clock_timestamp()-interval '1 day'`,
      })
      .where("lease_id", "=", leaseId)
      .execute();
  const seals = () =>
    db
      .selectFrom("runs")
      .select(["id", "output_seal_id"])
      .where("output_seal_id", "is not", null)
      .execute();
  async function trace<T>(work: () => Promise<T>) {
    const queries: string[] = [],
      original = Client.prototype.query;
    const spy = vi.spyOn(Client.prototype, "query").mockImplementation(function (
      this: Client,
      ...args: unknown[]
    ) {
      const query = args[0];
      queries.push(typeof query === "string" ? query : (query as { text: string }).text);
      return Reflect.apply(original, this, args);
    } as typeof original);
    try {
      return { result: await work(), queries };
    } finally {
      spy.mockRestore();
    }
  }

  it.each([1, 8, 64])("keeps one-expiry SQL independent of %i Session siblings", async (count) => {
    const f = await fixture();
    const tasks: Awaited<ReturnType<typeof f.start>>[] = [];
    for (let i = 0; i < count; i++) tasks.push(await f.start());
    await db
      .updateTable("session_leases")
      .set({ valid_until: sql<Date>`clock_timestamp()+interval '10 minutes'` })
      .execute();
    const m = manager(),
      idle = await trace(() => m.sweepExpiredExecutions());
    expect(idle.queries).toHaveLength(1);
    expect(idle.result.expiredAssignments).toBe(0);
    await expire(tasks[0]!.leaseId);
    const sample = await trace(() => m.sweepExpiredExecutions());
    expect(sample.result.expiredAssignments).toBe(1);
    expect(await seals()).toHaveLength(1);
    const physicalLocks = sample.queries.filter(
      (q) => q.includes('from "pi_sessions"') && q.includes("for update"),
    );
    expect(physicalLocks).toHaveLength(1);
    // The same constant budget must hold for 1/8/64 Sessions.
    expect(sample.queries).toHaveLength(13);
    process.stdout.write(
      JSON.stringify({
        probe: "expiry-sql",
        sessions: count,
        sql: sample.queries.length,
        businessSql: sample.queries.filter((q) => !/^(begin|commit|rollback)\b/i.test(q)).length,
      }) + "\n",
    );
  });

  it.each([false, true])(
    "makes progress while a healthy/expired Session is locked: expired=%s",
    async (lockedExpired) => {
      const f = await fixture(),
        busy = await f.start(),
        first = await f.start();
      const other = await f.start(await createTestWorker(db));
      await expire(first.leaseId);
      await expire(other.leaseId);
      if (lockedExpired) await expire(busy.leaseId);
      const locked = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const blocker = db.transaction().execute(async (tx) => {
        await tx
          .selectFrom("pi_sessions")
          .select("id")
          .where("id", "=", busy.sessionId)
          .forUpdate()
          .execute();
        locked.resolve();
        await release.promise;
      });
      const m = manager();
      try {
        await locked.promise;
        expect((await m.sweepExpiredExecutions()).expiredAssignments).toBe(2);
        expect(await seals()).toHaveLength(2);
        // Earlier locks from the skipped candidate were rolled back, not retained.
        await db
          .transaction()
          .execute((tx) =>
            tx
              .selectFrom("runs")
              .select("id")
              .where("id", "=", busy.runId)
              .forUpdate()
              .noWait()
              .execute(),
          );
      } finally {
        release.resolve();
        await blocker;
      }
      expect((await m.sweepExpiredExecutions()).expiredAssignments).toBe(lockedExpired ? 1 : 0);
      if (!lockedExpired)
        expect(
          (
            await db
              .selectFrom("session_leases")
              .select("writer_failed_at")
              .where("lease_id", "=", busy.leaseId)
              .executeTakeFirstOrThrow()
          ).writer_failed_at,
        ).toBeNull();
    },
  );

  it("pages past an entire busy batch and revisits it after unlock", async () => {
    const f = await fixture();
    const tasks: Awaited<ReturnType<typeof f.start>>[] = [];
    for (let i = 0; i < 5; i++) {
      const t = await f.start();
      await expire(t.leaseId);
      tasks.push(t);
    }
    tasks.sort((a, b) => a.leaseId.localeCompare(b.leaseId));
    const locked = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const blocker = db.transaction().execute(async (tx) => {
      await tx
        .selectFrom("pi_sessions")
        .select("id")
        .where(
          "id",
          "in",
          tasks.slice(0, 4).map((t) => t.sessionId),
        )
        .forUpdate()
        .execute();
      locked.resolve();
      await release.promise;
    });
    const m = manager();
    try {
      await locked.promise;
      expect((await m.sweepExpiredExecutions(2)).expiredAssignments).toBe(0);
      expect((await m.sweepExpiredExecutions(2)).expiredAssignments).toBe(0);
      expect((await m.sweepExpiredExecutions(2)).expiredAssignments).toBe(1);
      expect(await seals()).toHaveLength(1);
    } finally {
      release.resolve();
      await blocker;
    }
    expect((await m.sweepExpiredExecutions(2)).expiredAssignments).toBe(2);
    expect((await m.sweepExpiredExecutions(2)).expiredAssignments).toBe(2);
    expect(await seals()).toHaveLength(5);
  });

  it("skips a locked management Host while unrelated Session expiry progresses", async () => {
    const f = await fixture(),
      task = await f.start(await createTestWorker(db));
    await expire(task.leaseId);
    await db
      .updateTable("supervisor_connections")
      .set({ expires_at: sql<Date>`clock_timestamp()-interval '1 millisecond'` })
      .where("worker_id", "=", f.worker.workerId)
      .execute();
    const w = await db
      .selectFrom("workers")
      .select("supervisor_id")
      .where("id", "=", f.worker.workerId)
      .executeTakeFirstOrThrow();
    const locked = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const blocker = db.transaction().execute(async (tx) => {
      await tx
        .selectFrom("supervisor_hosts")
        .select("supervisor_id")
        .where("supervisor_id", "=", w.supervisor_id)
        .forUpdate()
        .execute();
      locked.resolve();
      await release.promise;
    });
    const m = manager();
    try {
      await locked.promise;
      expect((await m.expireConnections()).expiredConnections).toBe(0);
      expect((await m.sweepExpiredExecutions()).expiredAssignments).toBe(1);
    } finally {
      release.resolve();
      await blocker;
    }
    expect((await m.expireConnections()).expiredConnections).toBe(1);
    expect(await db.selectFrom("worker_retirements").selectAll().execute()).toHaveLength(0);
  });

  it("admits the eleventh Worker without releasing ten pending seals", async () => {
    const f = await fixture();
    for (let i = 0; i < 11; i++) {
      const t = await f.start(i === 0 ? f.worker : await createTestWorker(db));
      await expire(t.leaseId);
    }
    const m = manager();
    expect((await m.sweepExpiredExecutions(10)).expiredAssignments).toBe(10);
    expect((await m.sweepExpiredExecutions(10)).expiredAssignments).toBe(1);
    expect((await m.sweepExpiredExecutions(10)).expiredAssignments).toBe(0);
    expect(await seals()).toHaveLength(11);
    expect(
      await db
        .selectFrom("session_leases")
        .select("lease_id")
        .where("released_at", "is", null)
        .execute(),
    ).toHaveLength(11);
    // Projection, rather than scan position, releases ownership.
    const pending = await db
      .selectFrom("outbox")
      .select("payload")
      .where("aggregate_type", "=", "session_terminal_event")
      .execute();
    for (let i = 0; i < pending.length; i++)
      await new ExecutionStreamProjector(db).project({
        fact: pending[i]!.payload as unknown as AcceptedFact,
        topic: "expiry-test",
        partition: 0,
        offset: BigInt(i + 1),
      });
    expect(
      await db
        .selectFrom("session_leases")
        .select("lease_id")
        .where("released_at", "is", null)
        .execute(),
    ).toHaveLength(0);
  });

  it("reconciles duplicate scans and restart against one durable seal", async () => {
    const f = await fixture(),
      task = await f.start();
    await expire(task.leaseId);
    await Promise.all([manager().sweepExpiredExecutions(), manager().sweepExpiredExecutions()]);
    expect(await seals()).toHaveLength(1);
    expect((await manager().sweepExpiredExecutions()).expiredAssignments).toBe(0);
    expect(
      await db
        .selectFrom("outbox")
        .select("id")
        .where("aggregate_type", "=", "session_terminal_event")
        .execute(),
    ).toHaveLength(1);
    expect(
      (
        await db
          .selectFrom("session_leases")
          .select("released_at")
          .where("lease_id", "=", task.leaseId)
          .executeTakeFirstOrThrow()
      ).released_at,
    ).toBeNull();
  });
  it("retires a failed connected Worker through durable admission after controller restart", async () => {
    const f = await fixture();
    const connection = await db
      .selectFrom("supervisor_connections")
      .selectAll()
      .where("worker_id", "=", f.worker.workerId)
      .where("state", "=", "active")
      .executeTakeFirstOrThrow();
    const m = manager(connection.control_plane_instance_id);
    const supervisor = new AgentRunSupervisor({
      maxConcurrentSessions: 128,
      runner: {
        async run(_command, _publish, signal) {
          await new Promise<void>((r) => {
            if (signal.aborted) r();
            else signal.addEventListener("abort", () => r(), { once: true });
          });
          throw new PiTurnCancelledError("session_lease_revoked", false);
        },
      },
    });
    const fault = vi
      .spyOn(f.worker.coordinator, "renewFromHeartbeat")
      .mockRejectedValue(new Error("Injected renewal failure"));
    const backend = new AgentRunExecutionBackend({
      supervisor,
      leaseCoordinator: f.worker.coordinator,
      executionLogs: new WorkerExecutionLog({
        append: async (fact) => ({ factId: fact.factId, durable: true }),
        checkHealth: async () => {},
      }),
    });
    const session = await f.store.createSession(
      f.project.projectId,
      f.project.workspaceId,
      "Failure",
      "elastic",
    );
    const accepted = await f.store.acceptTurn(session.sessionId, randomUUID(), {
      prompt: "Review failure",
    });
    const result = await f.worker
      .executor({ execute: (...args) => backend.execute(...args) })
      .dispatchRun(accepted.runId);
    fault.mockRestore();
    expect(result.status).toBe("recovering");
    expect(backend.healthy).toBe(false);
    const heartbeat = () =>
      m.heartbeat(
        {
          protocolVersion: 1,
          messageId: randomUUID(),
          sentAt: new Date().toISOString(),
          type: "supervisor.heartbeat",
          payload: {
            supervisorId: connection.supervisor_id,
            bootId: connection.boot_id,
            connectionId: connection.connection_id,
            acceptingAssignments: false,
            maxConcurrentSessions: 128,
            families: [],
          },
        },
        {
          supervisorId: connection.supervisor_id,
          bootId: connection.boot_id,
          sandboxId: f.worker.workerId,
          transportId: connection.transport_id,
        },
      );
    expect((await heartbeat()).type).toBe("supervisor.heartbeat.ack");
    const admitted = await Promise.all([m.admitFailedWorkers(), manager().admitFailedWorkers()]);
    expect(admitted.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await manager().admitFailedWorkers()).toBe(0);
    await expect(heartbeat()).rejects.toMatchObject({ code: "stale_connection", retryable: false });
    expect(
      await db
        .selectFrom("worker_retirements")
        .select(["worker_id", "boot_id", "reason"])
        .execute(),
    ).toEqual([
      { worker_id: f.worker.workerId, boot_id: connection.boot_id, reason: "worker_failed" },
    ]);
    const stopped = vi.fn(async () => {});
    const restarted = new SupervisorConnectionManager({
      database: db,
      controlPlaneInstanceId: randomUUID(),
      ownerBoundary: { stopAndConfirm: stopped },
      assignmentRetirerFactory: (identity) =>
        new AssignmentReconciler({
          database: db,
          workerId: identity.sandboxId,
          inventory: {
            listAssignments: async () => [],
            terminateAndConfirmAbsent: async () => {
              throw new Error("Unexpected Tool stop");
            },
          },
        }),
    });
    expect((await restarted.processNextRetirement()).kind).toBe("retired");
    expect(stopped).toHaveBeenCalledWith({
      supervisorId: connection.supervisor_id,
      bootId: connection.boot_id,
      sandboxId: f.worker.workerId,
    });
    expect((await restarted.processNextRetirement()).kind).toBe("idle");
    expect(
      (
        await db
          .selectFrom("workers")
          .select("state")
          .where("id", "=", f.worker.workerId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe("terminated");
  });

  it("rotates failed-Worker admission past a locked Host", async () => {
    const f = await fixture(),
      other = await createTestWorker(db);
    await f.worker.coordinator.quarantineWorker();
    await other.coordinator.quarantineWorker();
    const owners = await db
      .selectFrom("workers")
      .select(["id", "supervisor_id"])
      .where("state", "=", "failed")
      .orderBy("id")
      .execute();
    const locked = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const blocker = db.transaction().execute(async (tx) => {
      await tx
        .selectFrom("supervisor_hosts")
        .select("supervisor_id")
        .where("supervisor_id", "=", owners[0]!.supervisor_id)
        .forUpdate()
        .execute();
      locked.resolve();
      await release.promise;
    });
    const m = manager();
    try {
      await locked.promise;
      expect(await m.admitFailedWorkers(1)).toBe(0);
      expect(await m.admitFailedWorkers(1)).toBe(1);
      expect(await m.admitFailedWorkers(1)).toBe(0);
    } finally {
      release.resolve();
      await blocker;
    }
    expect(await m.admitFailedWorkers(1)).toBe(1);
    expect(await db.selectFrom("worker_retirements").select("worker_id").execute()).toHaveLength(2);
  });

  it.each(["seal", "retirement"])(
    "recovers a lost %s COMMIT reply from durable state",
    async (kind) => {
      const f = await fixture();
      if (kind === "seal") await expire((await f.start()).leaseId);
      else await f.worker.coordinator.quarantineWorker();
      const original = Client.prototype.query;
      let injected = false;
      const spy = vi.spyOn(Client.prototype, "query").mockImplementation(function (
        this: Client,
        ...args: unknown[]
      ) {
        const text = typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text;
        const result = Reflect.apply(original, this, args);
        if (!injected && /^commit$/i.test(text)) {
          injected = true;
          return Promise.resolve(result).then(() => {
            throw Object.assign(new Error("Injected lost COMMIT reply"), { code: "ECONNRESET" });
          });
        }
        return result;
      } as typeof original);
      try {
        const m = manager();
        await expect(
          kind === "seal" ? m.sweepExpiredExecutions() : m.admitFailedWorkers(),
        ).rejects.toThrow("Injected lost COMMIT reply");
      } finally {
        spy.mockRestore();
      }
      expect(injected).toBe(true);
      const restarted = manager();
      if (kind === "seal") {
        expect((await restarted.sweepExpiredExecutions()).expiredAssignments).toBe(0);
        expect(
          await db
            .selectFrom("outbox")
            .select("id")
            .where("aggregate_type", "=", "session_terminal_event")
            .execute(),
        ).toHaveLength(1);
      } else {
        expect(await restarted.admitFailedWorkers()).toBe(0);
        expect(
          await db.selectFrom("worker_retirements").select("worker_id").execute(),
        ).toHaveLength(1);
      }
    },
  );

  it("evicts a stalled maintenance query and releases its PG locks", async () => {
    const f = await fixture(),
      task = await f.start();
    await expire(task.leaseId);
    const url = new URL(endpoint!);
    url.pathname = `/${name}`;
    url.searchParams.set("application_name", `${name}_bounded`);
    const bounded = createDatabase({
      connectionString: url.toString(),
      maxConnections: 1,
      checkoutTimeoutMs: 250,
    });
    const m = new SupervisorConnectionManager({
      database: db,
      maintenanceDatabase: bounded,
      controlPlaneInstanceId: randomUUID(),
      ownerBoundary: {
        stopAndConfirm: async () => {
          throw new Error("Unexpected physical stop");
        },
      },
      assignmentRetirerFactory: () => {
        throw new Error("No Worker retirement during scan");
      },
    });
    const locked = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const blocker = db.transaction().execute(async (tx) => {
      await sql`lock table session_leases in access exclusive mode`.execute(tx);
      locked.resolve();
      await release.promise;
    });
    try {
      await locked.promise;
      await expect(m.sweepExpiredExecutions()).rejects.toThrow();
      await vi.waitFor(
        async () => {
          const rows = await sql<{
            n: number;
          }>`select count(*)::int n from pg_stat_activity where application_name=${name + "_bounded"}`.execute(
            admin,
          );
          expect(rows.rows[0]!.n).toBe(0);
        },
        { timeout: 3000 },
      );
    } finally {
      release.resolve();
      await blocker;
    }
    try {
      expect((await m.sweepExpiredExecutions()).expiredAssignments).toBe(1);
    } finally {
      await bounded.destroy();
    }
  });
});
