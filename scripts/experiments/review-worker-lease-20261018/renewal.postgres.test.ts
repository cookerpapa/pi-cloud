// Baseline characterizations against disposable PostgreSQL; never production.
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SessionLeaseCoordinator } from "../../../packages/runtime-core/src/session-lease-coordinator.ts";
import { ControlPlaneStore } from "../../../packages/control-plane/src/control-plane-store.ts";
import { createPrivateTenant } from "../../../packages/control-plane/src/tenant-administration.ts";
import { registerTestWorker } from "../../../packages/control-plane/test/fixtures/registered-worker.ts";
import { RunExecutor } from "../../../packages/runtime-core/src/run-executor.ts";
import { WorkerExecutionLog } from "../../../packages/runtime-core/src/worker-execution-log.ts";
import { AgentRunExecutionBackend } from "../../../packages/supervisor-host/src/agent-run-execution-backend.ts";
import { AgentRunSupervisor, PiTurnCancelledError } from "@pi-cloud/sandbox-supervisor";
import type { SupervisorHeartbeatMessage } from "@pi-cloud/protocol";

const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
describe.skipIf(!endpoint)("Worker lease renewal review", () => {
  const name = `pi_lease_review_${randomUUID().replaceAll("-", "")}`;
  let admin: Kysely<Database>, db: Kysely<Database>;
  beforeAll(async () => {
    admin = createDatabase({ connectionString: endpoint!, maxConnections: 1 });
    await sql`create database ${sql.id(name)}`.execute(admin);
    const url = new URL(endpoint!);
    url.pathname = `/${name}`;
    url.searchParams.set("application_name", name);
    // Fixture watchdog only: production authority pool supplies neither timeout.
    url.searchParams.set(
      "options",
      "-c statement_timeout=8000 -c idle_in_transaction_session_timeout=15000",
    );
    db = createDatabase({ connectionString: url.toString(), maxConnections: 6 });
    await runMigrations(db, "up");
  }, 60_000);
  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      try {
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
      } finally {
        await admin.destroy();
      }
    }
  });
  async function fixture(count: number) {
    const tenant = await createPrivateTenant(db, {
      slug: `lease-review-${randomUUID()}`,
      ownerDisplayName: "Lease review",
    });
    const store = new ControlPlaneStore({ database: db, ...tenant });
    const project = await store.createProject({ name: "Lease review", source: { kind: "empty" } });
    const workerId = randomUUID();
    await db
      .insertInto("workers")
      .values({
        id: workerId,
        supervisor_id: workerId,
        boot_id: randomUUID(),
        state: "ready",
        max_concurrent_sessions: 8,
      })
      .execute();
    const coordinator = new SessionLeaseCoordinator({ database: db, workerId });
    const families: SupervisorHeartbeatMessage["payload"]["families"] = [];
    for (let i = 0; i < count; i++) {
      const session = await store.createSession(
        project.projectId,
        project.workspaceId,
        `Session ${i}`,
        "elastic",
      );
      const leaseId = randomUUID();
      await db
        .updateTable("pi_sessions")
        .set({ lease_epoch: "1" })
        .where("tenant_id", "=", tenant.tenantId)
        .where("id", "=", session.sessionId)
        .execute();
      await db
        .insertInto("session_leases")
        .values({
          tenant_id: tenant.tenantId,
          pi_session_id: session.sessionId,
          lease_id: leaseId,
          worker_id: workerId,
          fencing_token: "1",
          valid_until: sql<Date>`clock_timestamp()+interval '60 seconds'`,
          acquired_at: sql<Date>`clock_timestamp()`,
          renewed_at: sql<Date>`clock_timestamp()`,
        })
        .execute();
      families.push({
        tenantId: tenant.tenantId,
        piSessionId: session.sessionId,
        leaseId,
        writerId: leaseId,
        fencingToken: 1,
      });
    }
    const identity = await coordinator.heartbeatIdentity();
    const heartbeat = (reported = families) => ({
      protocolVersion: 1,
      messageId: randomUUID(),
      sentAt: new Date().toISOString(),
      type: "supervisor.heartbeat",
      payload: {
        ...identity,
        maxConcurrentSessions: 8,
        acceptingAssignments: true,
        families: reported,
      },
    });
    return { tenant, store, project, workerId, coordinator, families, heartbeat };
  }
  it("measures constant renewal SQL for one versus eight physical Sessions", async () => {
    const f = await fixture(8);
    for (const size of [1, 8]) {
      const samples: number[] = [],
        counts: number[] = [];
      let first: string[] = [];
      for (let i = 0; i < 10; i++) {
        const statements: string[] = [];
        const original = Client.prototype.query;
        const spy = vi.spyOn(Client.prototype, "query").mockImplementation(function (
          this: Client,
          ...args: unknown[]
        ) {
          const q = args[0];
          statements.push(typeof q === "string" ? q : (q as { text: string }).text);
          return Reflect.apply(original, this, args);
        } as typeof original);
        const started = performance.now();
        try {
          const ack = await f.coordinator.renewFromHeartbeat(
            f.heartbeat(f.families.slice(0, size)),
          );
          expect(ack.payload.familyLeaseRenewals).toHaveLength(size);
        } finally {
          spy.mockRestore();
        }
        samples.push(performance.now() - started);
        counts.push(statements.length);
        first = statements.map((q) => q.trim().split(/\s/)[0]!.toLowerCase());
        expect(statements).toHaveLength(5);
        expect(statements.some((q) => /supervisor_connections|update\s+"?runs\b/i.test(q))).toBe(
          false,
        );
      }
      samples.sort((a, b) => a - b);
      process.stdout.write(
        JSON.stringify({
          probe: "renewal-sql",
          sessions: size,
          samples: samples.length,
          sqlIncludingTransaction: counts,
          verbs: first,
          p50Ms: samples[4],
          p95Ms: samples[9],
        }) + "\n",
      );
    }
  });
  it("characterizes one locked lease preventing renewal of another physical Session", async () => {
    const f = await fixture(2);
    await db
      .updateTable("session_leases")
      .set({ valid_until: sql<Date>`clock_timestamp()+interval '1 second'` })
      .where("worker_id", "=", f.workerId)
      .execute();
    const locked = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const blocker = db.transaction().execute(async (tx) => {
      await tx
        .selectFrom("session_leases")
        .select("lease_id")
        .where("lease_id", "=", f.families[0]!.leaseId)
        .forNoKeyUpdate()
        .execute();
      locked.resolve();
      await release.promise;
    });
    let pending: ReturnType<SessionLeaseCoordinator["renewFromHeartbeat"]> | undefined;
    try {
      await locked.promise;
      pending = f.coordinator.renewFromHeartbeat(f.heartbeat());
      await vi.waitFor(async () => {
        const waiters = await sql<{
          n: number;
        }>`select count(*)::int n from pg_stat_activity where application_name=${name} and wait_event_type='Lock'`.execute(
          db,
        );
        expect(waiters.rows[0]!.n).toBeGreaterThan(0);
      });
      await vi.waitFor(
        async () => {
          const rows = await db
            .selectFrom("session_leases")
            .select(sql<boolean>`valid_until<=clock_timestamp()`.as("expired"))
            .where("worker_id", "=", f.workerId)
            .execute();
          expect(rows).toEqual([{ expired: true }, { expired: true }]);
        },
        { timeout: 3000 },
      );
    } finally {
      release.resolve();
      await blocker;
    }
    const ack = await pending!;
    expect(ack.payload.familyLeaseRenewals).toEqual([]);
    process.stdout.write(
      JSON.stringify({
        probe: "renewal-lock-coupling",
        blockedRows: 1,
        expiredSessions: 2,
        renewalsAfterUnlock: 0,
        expiredLeaseRevived: false,
      }) + "\n",
    );
  });
  it("characterizes local revocation waiting behind the PG quarantine write", async () => {
    const f = await fixture(0);
    await registerTestWorker(db, f.workerId);
    const session = await f.store.createSession(
      f.project.projectId,
      f.project.workspaceId,
      "Quarantine order",
      "elastic",
    );
    const quarantineEntered = Promise.withResolvers<void>(),
      quarantineRelease = Promise.withResolvers<void>();
    let runnerSignal: AbortSignal | undefined;
    const supervisor = new AgentRunSupervisor({
      maxConcurrentSessions: 8,
      runner: {
        async run(_command, _publish, signal) {
          runnerSignal = signal;
          await new Promise<void>((resolve) => {
            if (signal.aborted) resolve();
            else signal.addEventListener("abort", () => resolve(), { once: true });
          });
          throw new PiTurnCancelledError("session_lease_revoked", false);
        },
      },
    });
    const failed = vi
      .spyOn(f.coordinator, "renewFromHeartbeat")
      .mockRejectedValue(new Error("Injected PG renewal connection loss"));
    const quarantine = vi.spyOn(f.coordinator, "quarantineWorker").mockImplementation(async () => {
      quarantineEntered.resolve();
      await quarantineRelease.promise;
    });
    const logs = new WorkerExecutionLog({
      append: async (fact) => ({ factId: fact.factId, durable: true }),
      checkHealth: async () => {},
    });
    const backend = new AgentRunExecutionBackend({
      supervisor,
      leaseCoordinator: f.coordinator,
      executionLogs: logs,
    });
    const executor = new RunExecutor({
      database: db,
      workerId: f.workerId,
      executionAuthority: f.coordinator,
      backend,
    });
    const accepted = await f.store.acceptTurn(session.sessionId, randomUUID(), {
      prompt: "Review only",
    });
    const done = executor.dispatchRun(accepted.runId);
    const completion = done.then(
      (r) => ({ result: r }),
      (e) => ({ error: e }),
    );
    try {
      await quarantineEntered.promise;
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(runnerSignal).toBeDefined();
      expect(runnerSignal!.aborted).toBe(false);
      process.stdout.write(
        JSON.stringify({
          probe: "quarantine-before-local-revoke",
          renewalRejected: true,
          quarantinePending: true,
          runnerAborted: false,
        }) + "\n",
      );
    } finally {
      quarantineRelease.resolve();
      await completion;
      failed.mockRestore();
      quarantine.mockRestore();
    }
    expect(runnerSignal!.aborted).toBe(true);
  });
});
