// Real PostgreSQL coverage for ADR-0258 lease renewal boundaries.
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SessionLeaseCoordinator } from "../../runtime-core/src/session-lease-coordinator.ts";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { registerTestWorker } from "./fixtures/registered-worker.ts";
import { RunExecutor } from "../../runtime-core/src/run-executor.ts";
import { WorkerExecutionLog } from "../../runtime-core/src/worker-execution-log.ts";
import { AgentRunExecutionBackend } from "../../supervisor-host/src/agent-run-execution-backend.ts";
import { AgentRunSupervisor, PiTurnCancelledError } from "@pi-cloud/sandbox-supervisor";
import type { SupervisorHeartbeatMessage } from "@pi-cloud/protocol";

const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
describe.skipIf(!endpoint)("Worker lease renewal boundaries", () => {
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
  it.each([false, true])(
    "renews healthy siblings while A is locked; expire A=%s",
    async (expire) => {
      const f = await fixture(2);
      if (expire)
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
      try {
        await locked.promise;
        const ack = await f.coordinator.renewFromHeartbeat(f.heartbeat());
        expect(ack.payload.familyLeaseDeferrals).toEqual([
          { leaseId: f.families[0]!.leaseId, fencingToken: 1 },
        ]);
        expect(ack.payload.familyLeaseRenewals.map((r) => r.leaseId)).toEqual([
          f.families[1]!.leaseId,
        ]);
        for (const changed of [
          { fencingToken: 2 },
          { tenantId: randomUUID() },
          { piSessionId: randomUUID() },
          { writerId: randomUUID() },
        ]) {
          const rejected = await f.coordinator.renewFromHeartbeat(
            f.heartbeat([{ ...f.families[0]!, ...changed }]),
          );
          expect(rejected.payload.familyLeaseDeferrals).toEqual([]);
          expect(rejected.payload.familyLeaseRenewals).toEqual([]);
        }
        if (expire) {
          await vi.waitFor(
            async () => {
              const rows = await db
                .selectFrom("session_leases")
                .select(["lease_id", sql<boolean>`valid_until<=clock_timestamp()`.as("expired")])
                .where("worker_id", "=", f.workerId)
                .execute();
              expect(new Map(rows.map((r) => [r.lease_id, r.expired]))).toEqual(
                new Map([
                  [f.families[0]!.leaseId, true],
                  [f.families[1]!.leaseId, false],
                ]),
              );
            },
            { timeout: 3000 },
          );
          const expired = await f.coordinator.renewFromHeartbeat(f.heartbeat());
          expect(expired.payload.familyLeaseDeferrals).toEqual([]);
          expect(expired.payload.familyLeaseRenewals.map((r) => r.leaseId)).toEqual([
            f.families[1]!.leaseId,
          ]);
        }
      } finally {
        release.resolve();
        await blocker;
      }
      const after = await f.coordinator.renewFromHeartbeat(f.heartbeat());
      expect(after.payload.familyLeaseDeferrals).toEqual([]);
      expect(after.payload.familyLeaseRenewals).toHaveLength(expire ? 1 : 2);
    },
  );
  it("revokes locally and rejects new work before awaiting PG quarantine", async () => {
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
      expect(runnerSignal!.aborted).toBe(true);
      expect(backend.healthy).toBe(false);
      process.stdout.write(
        JSON.stringify({
          probe: "quarantine-before-local-revoke",
          renewalRejected: true,
          quarantinePending: true,
          runnerAborted: true,
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
