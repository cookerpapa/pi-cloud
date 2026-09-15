import { randomUUID } from "node:crypto";
import { createDatabase, databaseTime, runMigrations, type Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import { beforeAll, afterAll, afterEach, describe, it, expect, vi } from "vitest";
import { RunExecutor, type TurnExecutionRequest } from "@pi-cloud/runtime-core/run-executor";
import { SessionLeaseCoordinator } from "@pi-cloud/runtime-core/session-lease-coordinator";
import { openExecutionPublication } from "../../runtime-core/src/execution-publication.ts";
import { AssignmentReconciler } from "../src/assignment-reconciler.ts";
import { PostgresWorkspaceRuntimeStateRepository } from "@pi-cloud/tool-broker";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { createPrivateTenant } from "../src/tenant-administration.ts";

const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
describe.skipIf(!endpoint)("PostgreSQL authority decision time", () => {
  const name = `pi_authority_time_${randomUUID().replaceAll("-", "")}`;
  let admin: Kysely<Database>, db: Kysely<Database>;
  const running: Array<{ release(): void; done: Promise<unknown> }> = [];
  beforeAll(async () => {
    admin = createDatabase({ connectionString: endpoint!, maxConnections: 1 });
    await sql`create database ${sql.id(name)}`.execute(admin);
    const url = new URL(endpoint!);
    url.pathname = `/${name}`;
    url.searchParams.set("application_name", name);
    url.searchParams.set(
      "options",
      "-c statement_timeout=5000 -c idle_in_transaction_session_timeout=10000",
    );
    db = createDatabase({ connectionString: url.toString(), maxConnections: 5 });
    await runMigrations(db, "up");
  }, 60000);
  afterEach(async () => {
    const tasks = running.splice(0);
    for (const task of tasks) task.release();
    await Promise.allSettled(tasks.map((task) => task.done));
  });
  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      await sql`drop database if exists ${sql.id(name)} with (force)`.execute(admin);
      await admin.destroy();
    }
  });
  async function fixture(
    skewMs = 0,
    beforeAcquire?: (request: TurnExecutionRequest) => Promise<void>,
  ) {
    const tenant = await createPrivateTenant(db, {
      slug: `clock-${randomUUID()}`,
      ownerDisplayName: "clock test",
    });
    const store = new ControlPlaneStore({ database: db, ...tenant });
    const project = await store.createProject({ name: "clock", source: { kind: "empty" } });
    const session = await store.createSession(
      project.projectId,
      project.workspaceId,
      "clock",
      "elastic",
    );
    const workerId = randomUUID();
    await db
      .insertInto("sandboxes")
      .values({
        id: workerId,
        supervisor_id: workerId,
        boot_id: randomUUID(),
        state: "ready",
        max_concurrent_sessions: 1,
        active_sessions: 0,
      })
      .execute();
    const coordinator = new SessionLeaseCoordinator({
      database: db,
      sandboxId: workerId,
      clock: () => new Date(Date.now() + skewMs),
      leaseDurationMs: 60000,
    });
    const ready = Promise.withResolvers<{ request: TurnExecutionRequest; reference: string }>();
    const finish = Promise.withResolvers<void>();
    const executor = new RunExecutor({
      database: db,
      claimOwnerId: workerId,
      executionAuthority: coordinator,
      backend: {
        execute: async (request, lifecycle) => {
          await beforeAcquire?.(request);
          const binding = await coordinator.acquire(request);
          await lifecycle.started(binding);
          ready.resolve({ request, reference: binding.executionReference });
          await finish.promise;
          return { stopReason: "stop" };
        },
      },
    });
    const accepted = await store.acceptTurn(session.sessionId, randomUUID(), {
      prompt: "clock check",
    });
    const done = executor.dispatchRun(accepted.runId);
    running.push({ release: () => finish.resolve(), done });
    const task = await Promise.race([
      ready.promise,
      done.then((result) => {
        throw new Error(`Premature completion ${JSON.stringify(result)}`);
      }),
    ]);
    const lease = await db
      .selectFrom("session_leases")
      .selectAll()
      .where("sandbox_id", "=", workerId)
      .executeTakeFirstOrThrow();
    const identity = await coordinator.heartbeatIdentity();
    const heartbeat = {
      protocolVersion: 1,
      messageId: randomUUID(),
      sentAt: new Date().toISOString(),
      type: "supervisor.heartbeat",
      payload: {
        ...identity,
        maxConcurrentSessions: 1,
        acceptingAssignments: true,
        families: [
          {
            tenantId: tenant.tenantId,
            piSessionId: session.sessionId,
            leaseId: lease.lease_id,
            writerId: lease.writer_id,
            fencingToken: Number(lease.fencing_token),
          },
        ],
      },
    };
    return { ...task, coordinator, lease, heartbeat, workerId, session };
  }
  it.each([-3600000, 3600000])("ignores an application clock offset of %i ms", async (skew) => {
    const f = await fixture(skew);
    const now = await databaseTime(db);
    expect(f.lease.valid_until.valueOf() - now.valueOf()).toBeGreaterThan(55000);
    expect(f.lease.valid_until.valueOf() - now.valueOf()).toBeLessThanOrEqual(60000);
    const ack = await f.coordinator.renewFromHeartbeat(f.heartbeat);
    expect(ack.payload.familyLeaseRenewals).toHaveLength(1);
    expect(Math.abs(Date.parse(ack.sentAt) - (await databaseTime(db)).valueOf())).toBeLessThan(
      1000,
    );
    await f.coordinator.assertCurrentGrant(f.request, { executionReference: f.reference });
  });
  it.each(["renew", "grant", "publication"])(
    "rejects %s if authority expires during lock wait",
    async (operation) => {
      const f = await fixture();
      await db
        .updateTable("session_leases")
        .set({ valid_until: sql<Date>`clock_timestamp() + interval '1 second'` })
        .where("lease_id", "=", f.lease.lease_id)
        .execute();
      const locked = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const blocker = db.transaction().execute(async (tx) => {
        if (operation === "publication")
          await tx
            .selectFrom("run_attempts")
            .select("id")
            .where("id", "=", f.request.attemptId)
            .forUpdate()
            .execute();
        else
          await tx
            .selectFrom("session_leases")
            .select("lease_id")
            .where("lease_id", "=", f.lease.lease_id)
            .forUpdate()
            .execute();
        locked.resolve();
        await release.promise;
      });
      let pending: Promise<PromiseSettledResult<unknown>[]> | undefined;
      try {
        await locked.promise;
        pending = Promise.allSettled([
          operation === "renew"
            ? f.coordinator.renewFromHeartbeat(f.heartbeat)
            : operation === "grant"
              ? f.coordinator.assertCurrentGrant(f.request, { executionReference: f.reference })
              : openExecutionPublication(db, {
                  executionReference: f.reference,
                  sessionId: f.request.sessionId,
                  turnId: f.request.turnId,
                  nextEventSeq: Number(f.request.nextEventSeq),
                  piSession: {
                    id: f.request.piSessionId,
                    lane: f.request.piSessionLane,
                    writerId: f.request.piSessionWriterId,
                  },
                }),
        ]);
        await vi.waitFor(async () => {
          const result = await sql<{
            n: number;
          }>`select count(*)::int as n from pg_stat_activity where application_name=${name} and wait_event_type='Lock'`.execute(
            db,
          );
          expect(result.rows[0]!.n).toBeGreaterThan(0);
        });
        await vi.waitFor(
          async () => {
            const row = await db
              .selectFrom("session_leases")
              .select(sql<boolean>`valid_until <= clock_timestamp()`.as("expired"))
              .where("lease_id", "=", f.lease.lease_id)
              .executeTakeFirstOrThrow();
            expect(row.expired).toBe(true);
          },
          { timeout: 3000, interval: 20 },
        );
      } finally {
        release.resolve();
        await blocker;
      }
      const result = (await pending)![0]!;
      if (operation === "renew")
        expect(result).toMatchObject({
          status: "fulfilled",
          value: { payload: { familyLeaseRenewals: [] } },
        });
      else expect(result.status).toBe("rejected");
      await expect(
        f.coordinator.assertCurrentGrant(f.request, { executionReference: f.reference }),
      ).rejects.toThrow();
    },
  );
  it("uses PG expiry for retirement, independent of the reaper clock", async () => {
    const f = await fixture();
    const reaper = (skew: number) =>
      new AssignmentReconciler({
        database: db,
        sandboxId: f.workerId,
        clock: () => new Date(Date.now() + skew),
        inventory: {
          listAssignments: async () => {
            throw new Error("No physical retirement");
          },
          terminateAndConfirmAbsent: async () => {
            throw new Error("No Tool replay or kill");
          },
        },
      });
    expect(await reaper(3600000).retireExpiredAssignments()).toMatchObject({
      settledAssignments: 0,
    });
    await db
      .updateTable("session_leases")
      .set({
        valid_until: sql<Date>`clock_timestamp() - interval '1 second'`,
        acquired_at: sql<Date>`clock_timestamp() - interval '2 seconds'`,
      })
      .where("lease_id", "=", f.lease.lease_id)
      .execute();
    expect(await reaper(-3600000).retireExpiredAssignments()).toMatchObject({
      settledAssignments: 1,
    });
    expect(
      (await f.coordinator.renewFromHeartbeat(f.heartbeat)).payload.familyLeaseRenewals,
    ).toEqual([]);
  });
  it("rechecks a stale expiry candidate after an earlier renewal commits", async () => {
    const f = await fixture();
    const original = await db
      .updateTable("session_leases")
      .set({ valid_until: sql<Date>`clock_timestamp() + interval '1 second'` })
      .where("lease_id", "=", f.lease.lease_id)
      .returning("valid_until")
      .executeTakeFirstOrThrow();
    const written = Promise.withResolvers<void>(),
      commit = Promise.withResolvers<void>();
    const renewal = db.transaction().execute(async (tx) => {
      await tx
        .updateTable("session_leases")
        .set({ valid_until: sql<Date>`clock_timestamp() + interval '60 seconds'` })
        .where("lease_id", "=", f.lease.lease_id)
        .execute();
      written.resolve();
      await commit.promise;
    });
    let retirement: ReturnType<AssignmentReconciler["retireExpiredAssignments"]> | undefined;
    try {
      await written.promise;
      await vi.waitFor(
        async () =>
          expect((await databaseTime(db)).valueOf()).toBeGreaterThan(
            original.valid_until.valueOf(),
          ),
        { timeout: 3000, interval: 20 },
      );
      const reaper = new AssignmentReconciler({
        database: db,
        sandboxId: f.workerId,
        inventory: {
          listAssignments: async () => {
            throw new Error("Not a physical retirement");
          },
          terminateAndConfirmAbsent: async () => {
            throw new Error("Not a physical retirement");
          },
        },
      });
      retirement = reaper.retireExpiredAssignments();
      await vi.waitFor(async () => {
        const r = await sql<{
          n: number;
        }>`select count(*)::int as n from pg_stat_activity where application_name=${name} and wait_event_type='Lock'`.execute(
          db,
        );
        expect(r.rows[0]!.n).toBeGreaterThan(0);
      });
    } finally {
      commit.resolve();
      await renewal;
    }
    expect(await retirement).toMatchObject({ settledAssignments: 0 });
    await f.coordinator.assertCurrentGrant(f.request, { executionReference: f.reference });
  });
  it("rejects issuance when the startup claim expires behind a Session lock", async () => {
    const entered = Promise.withResolvers<TurnExecutionRequest>(),
      proceed = Promise.withResolvers<void>();
    const pending = fixture(0, async (request) => {
      entered.resolve(request);
      await proceed.promise;
    });
    const outcome = pending.then(
      () => "issued",
      () => "rejected",
    );
    const request = await entered.promise;
    await db
      .updateTable("run_attempts")
      .set({ claim_expires_at: sql<Date>`clock_timestamp() + interval '1 second'` })
      .where("id", "=", request.attemptId)
      .execute();
    const locked = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const blocker = db.transaction().execute(async (tx) => {
      await tx
        .selectFrom("sessions")
        .select("id")
        .where("id", "=", request.sessionId)
        .forUpdate()
        .execute();
      locked.resolve();
      await release.promise;
    });
    try {
      await locked.promise;
      proceed.resolve();
      await vi.waitFor(async () => {
        const result = await sql<{
          n: number;
        }>`select count(*)::int as n from pg_stat_activity where application_name=${name} and wait_event_type='Lock'`.execute(
          db,
        );
        expect(result.rows[0]!.n).toBeGreaterThan(0);
      });
      await vi.waitFor(
        async () => {
          const row = await db
            .selectFrom("run_attempts")
            .select(sql<boolean>`claim_expires_at<=clock_timestamp()`.as("expired"))
            .where("id", "=", request.attemptId)
            .executeTakeFirstOrThrow();
          expect(row.expired).toBe(true);
        },
        { timeout: 3000, interval: 20 },
      );
    } finally {
      proceed.resolve();
      release.resolve();
      await blocker;
    }
    expect(await outcome).toBe("rejected");
    expect(
      await db
        .selectFrom("session_leases")
        .select("lease_id")
        .where("pi_session_id", "=", request.piSessionId)
        .execute(),
    ).toEqual([]);
  });
  it("does not revive a Broker owner after a delayed heartbeat", async () => {
    const instanceId = randomUUID();
    const broker = new PostgresWorkspaceRuntimeStateRepository({
      database: db,
      sandboxDomainId: "sandbox-domain-0001",
      instanceId,
      ownerBaseUrl: `http://broker-${instanceId}.internal:4300`,
      leaseMs: 1000,
      heartbeatMs: 100,
    });
    const locked = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let blocker: Promise<void> | undefined;
    try {
      await broker.start();
      blocker = db.transaction().execute(async (tx) => {
        await tx
          .selectFrom("tool_broker_instances")
          .select("instance_id")
          .where("instance_id", "=", instanceId)
          .forUpdate()
          .execute();
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      await vi.waitFor(async () => {
        const waiting = await sql<{
          n: number;
        }>`select count(*)::int as n from pg_stat_activity where application_name=${name} and wait_event_type='Lock'`.execute(
          db,
        );
        expect(waiting.rows[0]!.n).toBeGreaterThan(0);
      });
      await vi.waitFor(
        async () => {
          const row = await db
            .selectFrom("tool_broker_instances")
            .select(sql<boolean>`lease_expires_at <= clock_timestamp()`.as("expired"))
            .where("instance_id", "=", instanceId)
            .executeTakeFirstOrThrow();
          expect(row.expired).toBe(true);
        },
        { timeout: 3000, interval: 20 },
      );
      release.resolve();
      await blocker;
      await vi.waitFor(async () => {
        const row = await db
          .selectFrom("tool_broker_instances")
          .select("state")
          .where("instance_id", "=", instanceId)
          .executeTakeFirstOrThrow();
        expect(row.state).toBe("lost");
      });
      await expect(broker.checkHealth()).rejects.toMatchObject({ code: "ownership_lost" });
    } finally {
      release.resolve();
      await blocker;
      await broker.close();
    }
  });
});
