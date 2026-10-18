// Review characterizations of current behavior, not repaired-behavior regressions.
// All database work is confined to disposable migrated PostgreSQL databases.
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { sql, type Kysely } from "kysely";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ControlPlaneStore } from "../../../packages/control-plane/src/control-plane-store.ts";
import { createPrivateTenant } from "../../../packages/control-plane/src/tenant-administration.ts";
import { createTestWorker } from "../../../packages/control-plane/test/admit-test-execution.ts";
import { AssignmentReconciler } from "../../../packages/control-plane/src/assignment-reconciler.ts";
import { SupervisorConnectionManager } from "../../../packages/control-plane/src/supervisor-connection-manager.ts";
import { ExecutionStreamProjector } from "../../../packages/runtime-core/src/execution-stream-projection.ts";
import { WorkerExecutionLog } from "../../../packages/runtime-core/src/worker-execution-log.ts";
import { AgentRunExecutionBackend } from "../../../packages/supervisor-host/src/agent-run-execution-backend.ts";
import { AgentRunSupervisor, PiTurnCancelledError } from "@pi-cloud/sandbox-supervisor";
import { parseExecutionReference } from "@pi-cloud/protocol";
import type { AcceptedFact } from "../../../packages/runtime-core/src/accepted-fact.ts";

const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
describe.skipIf(!endpoint)("Control Plane expiry review", () => {
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
    const worker = await createTestWorker(db, 16);
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

  it.each([1, 8])(
    "measures an idle sweep and one expired owner among %i Sessions",
    async (count) => {
      const f = await fixture(),
        tasks = [];
      for (let i = 0; i < count; i++) tasks.push(await f.start());
      const m = manager();
      const idle = await trace(() => m.sweepExpiredExecutions());
      expect(idle.result.expiredAssignments).toBe(0);
      expect(idle.queries).toHaveLength(2);
      await expire(tasks[0]!.leaseId);
      const sample = await trace(() => m.sweepExpiredExecutions());
      expect(sample.result.expiredAssignments).toBe(1);
      expect(await seals()).toHaveLength(1);
      process.stdout.write(
        JSON.stringify({
          probe: "sweep-sql",
          sessions: count,
          expired: 1,
          idleSql: idle.queries.length,
          sqlIncludingTransaction: sample.queries.length,
          businessSql: sample.queries.filter((q) => !/^(begin|commit|rollback)\b/i.test(q)).length,
          physicalSessionLocks: sample.queries.filter(
            (q) => q.includes('from "pi_sessions"') && q.includes("for update"),
          ).length,
          sql: sample.queries,
        }) + "\n",
      );
    },
  );

  it("characterizes a healthy Session lock blocking expired Sessions on two Workers", async () => {
    const f = await fixture(),
      first = await f.start(),
      healthy = await f.start();
    const otherWorker = await createTestWorker(db),
      other = await f.start(otherWorker);
    await expire(first.leaseId, 2000);
    await expire(other.leaseId, 1000);
    const locked = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const blocker = db.transaction().execute(async (tx) => {
      await tx
        .selectFrom("pi_sessions")
        .select("id")
        .where("tenant_id", "=", f.tenant.tenantId)
        .where("id", "=", healthy.sessionId)
        .forUpdate()
        .execute();
      locked.resolve();
      await release.promise;
    });
    let pending: ReturnType<SupervisorConnectionManager["sweepExpiredExecutions"]> | undefined,
      settled = false;
    try {
      await locked.promise;
      pending = manager().sweepExpiredExecutions();
      pending.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );
      await vi.waitFor(async () => {
        const rows = await sql<{
          n: number;
        }>`select count(*)::int n from pg_stat_activity where application_name=${name} and wait_event_type='Lock' and query like '%"pi_sessions"%'`.execute(
          db,
        );
        expect(rows.rows[0]!.n).toBeGreaterThan(0);
      });
      await new Promise((r) => setTimeout(r, 1250));
      expect(settled).toBe(false);
      expect(await seals()).toHaveLength(0);
    } finally {
      release.resolve();
      await blocker;
    }
    expect((await pending!).expiredAssignments).toBe(2);
    expect(
      (
        await db
          .selectFrom("session_leases")
          .select("writer_failed_at")
          .where("lease_id", "=", healthy.leaseId)
          .executeTakeFirstOrThrow()
      ).writer_failed_at,
    ).toBeNull();
    process.stdout.write(
      JSON.stringify({
        probe: "healthy-session-lock",
        blockedMsAtLeast: 1250,
        sealsWhileBlocked: 0,
        sealsAfterUnlock: 2,
        healthyOwnerRevoked: false,
      }) + "\n",
    );
  });

  it("characterizes management expiry blocking the later Session expiry query", async () => {
    const f = await fixture(),
      idleWorker = f.worker,
      otherWorker = await createTestWorker(db),
      task = await f.start(otherWorker);
    await expire(task.leaseId);
    await db
      .updateTable("supervisor_connections")
      .set({ expires_at: sql<Date>`clock_timestamp()-interval '1 millisecond'` })
      .where("worker_id", "=", idleWorker.workerId)
      .execute();
    const locked = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const blocker = db.transaction().execute(async (tx) => {
      const w = await tx
        .selectFrom("workers")
        .select("supervisor_id")
        .where("id", "=", idleWorker.workerId)
        .executeTakeFirstOrThrow();
      await tx
        .selectFrom("supervisor_hosts")
        .select("supervisor_id")
        .where("supervisor_id", "=", w.supervisor_id)
        .forUpdate()
        .execute();
      locked.resolve();
      await release.promise;
    });
    let pending: ReturnType<SupervisorConnectionManager["sweepExpiredExecutions"]> | undefined;
    try {
      await locked.promise;
      pending = manager().sweepExpiredExecutions();
      await vi.waitFor(async () => {
        const rows = await sql<{
          n: number;
        }>`select count(*)::int n from pg_stat_activity where application_name=${name} and wait_event_type='Lock' and query like '%"supervisor_hosts"%'`.execute(
          db,
        );
        expect(rows.rows[0]!.n).toBeGreaterThan(0);
      });
      expect(await seals()).toHaveLength(0);
    } finally {
      release.resolve();
      await blocker;
    }
    expect((await pending!).expiredAssignments).toBe(1);
    process.stdout.write(
      JSON.stringify({
        probe: "management-lock",
        sessionSealWhileHostLocked: false,
        sessionSealAfterUnlock: true,
      }) + "\n",
    );
  });

  it("characterizes pending seals starving the eleventh Worker under the default scan window", async () => {
    const f = await fixture(),
      tasks = [];
    for (let i = 0; i < 11; i++) {
      const owner = i === 0 ? f.worker : await createTestWorker(db);
      const task = await f.start(owner);
      tasks.push(task);
      await expire(task.leaseId, i === 10 ? 1000 : 60000);
    }
    const m = manager();
    expect((await m.sweepExpiredExecutions()).expiredAssignments).toBe(10);
    const rounds = [];
    for (let i = 0; i < 3; i++) rounds.push((await m.sweepExpiredExecutions()).expiredAssignments);
    expect(rounds).toEqual([0, 0, 0]);
    expect(await seals()).toHaveLength(10);
    expect(
      (
        await db
          .selectFrom("runs")
          .select("output_seal_id")
          .where("id", "=", tasks[10]!.runId)
          .executeTakeFirstOrThrow()
      ).output_seal_id,
    ).toBeNull();
    const first = await db
      .selectFrom("runs")
      .select("output_seal_id")
      .where("id", "=", tasks[0]!.runId)
      .executeTakeFirstOrThrow();
    const row = await db
      .selectFrom("outbox")
      .select("payload")
      .where("id", "=", first.output_seal_id!)
      .executeTakeFirstOrThrow();
    await new ExecutionStreamProjector(db).project({
      fact: row.payload as unknown as AcceptedFact,
      topic: "expiry-review",
      partition: 0,
      offset: 1n,
    });
    expect((await m.sweepExpiredExecutions()).expiredAssignments).toBe(1);
    // Recovery requeues A and clears its current seal pointer; its immutable
    // Outbox record remains. Ten current requests now include the eleventh Worker.
    expect(await seals()).toHaveLength(10);
    expect(
      (
        await db
          .selectFrom("runs")
          .select("output_seal_id")
          .where("id", "=", tasks[10]!.runId)
          .executeTakeFirstOrThrow()
      ).output_seal_id,
    ).not.toBeNull();
    expect(
      await db
        .selectFrom("outbox")
        .select("id")
        .where("aggregate_type", "=", "session_terminal_event")
        .execute(),
    ).toHaveLength(11);
    process.stdout.write(
      JSON.stringify({
        probe: "scan-window-starvation",
        workers: 11,
        defaultWorkerWindow: 10,
        initialSeals: 10,
        repeatedNewSeals: rounds,
        newSealsAfterOneOldSealProjects: 1,
      }) + "\n",
    );
  });

  it("characterizes a failed Worker kept connected without a retirement record", async () => {
    const f = await fixture();
    const connection = await db
      .selectFrom("supervisor_connections")
      .selectAll()
      .where("worker_id", "=", f.worker.workerId)
      .where("state", "=", "active")
      .executeTakeFirstOrThrow();
    const m = manager(connection.control_plane_instance_id);
    const supervisor = new AgentRunSupervisor({
      maxConcurrentSessions: 16,
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
    for (let i = 0; i < 3; i++) {
      const ack = await m.heartbeat(
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
            maxConcurrentSessions: 16,
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
      expect(ack.type).toBe("supervisor.heartbeat.ack");
      await m.sweepExpiredExecutions();
      expect((await m.processNextRetirement()).kind).toBe("idle");
    }
    expect(
      (
        await db
          .selectFrom("workers")
          .select("state")
          .where("id", "=", f.worker.workerId)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe("failed");
    expect(
      (
        await db
          .selectFrom("supervisor_connections")
          .select("state")
          .where("connection_id", "=", connection.connection_id)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe("active");
    expect(await db.selectFrom("worker_retirements").select("worker_id").execute()).toHaveLength(0);
    process.stdout.write(
      JSON.stringify({
        probe: "failed-connected-worker",
        localBackendHealthy: false,
        workerState: "failed",
        heartbeatAcks: 3,
        connectionState: "active",
        retirementRows: 0,
        localRunRecoveryRequested: true,
      }) + "\n",
    );
  });
});
