import { randomUUID } from "node:crypto";
import { sql, type Kysely } from "kysely";
import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { createTestWorker } from "./admit-test-execution.ts";
import { registerTestWorker } from "./fixtures/registered-worker.ts";
import { SupervisorBootProvisioner } from "../src/supervisor-boot-provisioner.ts";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { createPrivateTenant } from "../src/tenant-administration.ts";

const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
describe.skipIf(!endpoint)("Worker transport expiry and Boot authority on PostgreSQL", () => {
  const name = `pi_reconnect_${randomUUID().replaceAll("-", "")}`;
  let admin: Kysely<Database>, db: Kysely<Database>;
  beforeAll(async () => {
    admin = createDatabase({ connectionString: endpoint!, maxConnections: 1 });
    await sql`create database ${sql.id(name)}`.execute(admin);
    const url = new URL(endpoint!);
    url.pathname = `/${name}`;
    url.searchParams.set(
      "options",
      "-c statement_timeout=10000 -c idle_in_transaction_session_timeout=15000",
    );
    db = createDatabase({ connectionString: url.toString(), maxConnections: 8 });
    await runMigrations(db, "up");
  }, 60000);
  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      await sql`drop database ${sql.id(name)}`.execute(admin);
      await admin.destroy();
    }
  });
  async function fixture() {
    const worker = await createTestWorker(db, 2);
    const registered = await registerTestWorker(db, worker.workerId);
    const connectionId = registered.registration.payload.connectionId;
    const reconnect = () =>
      registered.manager.register(
        { ...registered.message, messageId: randomUUID() },
        { ...registered.authority, transportId: randomUUID() },
      );
    const expire = () =>
      db
        .updateTable("supervisor_connections")
        .set({
          // Shift the whole heartbeat window. Merely placing expiry 1 ms ago
          // can precede the just-written heartbeat on a fast PostgreSQL host.
          last_heartbeat_at: sql<Date>`last_heartbeat_at - interval '2 hours'`,
          expires_at: sql<Date>`expires_at - interval '2 hours'`,
        })
        .where("connection_id", "=", connectionId)
        .execute();
    const state = () =>
      db
        .selectFrom("workers")
        .select("state")
        .where("id", "=", worker.workerId)
        .executeTakeFirstOrThrow();
    const retirement = () =>
      db
        .selectFrom("worker_retirements")
        .selectAll()
        .where("worker_id", "=", worker.workerId)
        .execute();
    const heartbeat = () =>
      registered.manager.heartbeat(
        {
          protocolVersion: 1,
          type: "supervisor.heartbeat",
          messageId: randomUUID(),
          sentAt: new Date().toISOString(),
          payload: {
            supervisorId: registered.authority.supervisorId,
            bootId: registered.authority.bootId,
            connectionId,
            acceptingAssignments: false,
            maxConcurrentSessions: 2,
            families: [],
          },
        },
        registered.authority,
      );
    return {
      ...worker,
      ...registered,
      connectionId,
      reconnect,
      expire,
      state,
      retirement,
      heartbeat,
    };
  }

  it.each(["register", "sweep", "heartbeat", "duplicate-register"] as const)(
    "retains an idle Boot when expiry is first observed by %s",
    async (entry) => {
      const f = await fixture();
      await f.expire();
      if (entry === "sweep") await f.manager.expireConnections();
      if (entry === "heartbeat")
        await expect(f.heartbeat()).rejects.toMatchObject({
          code: "stale_connection",
          retryable: true,
        });
      if (entry === "duplicate-register")
        await expect(f.manager.register(f.message, f.authority)).rejects.toMatchObject({
          code: "stale_registration",
          retryable: true,
        });
      const newConnection = await f.reconnect();
      expect(newConnection.payload.connectionId).not.toBe(f.connectionId);
      expect(newConnection.payload.bootId).toBe(f.authority.bootId);
      expect(await f.state()).toEqual({ state: "ready" });
      expect(await f.retirement()).toEqual([]);
      const beforeLateMessage = await db
        .selectFrom("supervisor_connections")
        .selectAll()
        .where("worker_id", "=", f.workerId)
        .orderBy("connection_id")
        .execute();
      expect(beforeLateMessage.find((c) => c.connection_id === f.connectionId)?.state).toBe(
        "expired",
      );
      await expect(f.heartbeat()).rejects.toMatchObject({ retryable: false });
      await expect(f.manager.register(f.message, f.authority)).rejects.toMatchObject({
        retryable: false,
      });
      expect(
        await db
          .selectFrom("supervisor_connections")
          .selectAll()
          .where("worker_id", "=", f.workerId)
          .orderBy("connection_id")
          .execute(),
      ).toEqual(beforeLateMessage);
      expect((await f.manager.expireConnections()).expiredConnectionIds).not.toContain(
        f.connectionId,
      );
    },
  );

  it("reuses an acknowledged registration only on the same current transport", async () => {
    const f = await fixture();
    expect(await f.manager.register(f.message, f.authority)).toEqual(f.registration);
    await expect(
      f.manager.register(f.message, { ...f.authority, transportId: randomUUID() }),
    ).rejects.toMatchObject({ code: "registration_replay", retryable: false });
    const recovered = await f.reconnect(); // a lost ACK needs no Boot restart
    expect(recovered.payload.bootId).toBe(f.authority.bootId);
    expect(
      await db
        .selectFrom("supervisor_connections")
        .selectAll()
        .where("worker_id", "=", f.workerId)
        .where("state", "=", "active")
        .execute(),
    ).toHaveLength(1);
  });

  it("checks credential expiry after waiting for a connection row lock", async () => {
    const f = await fixture();
    const locked = Promise.withResolvers<number>(),
      release = Promise.withResolvers<void>();
    const holding = db.transaction().execute(async (tx) => {
      await tx
        .selectFrom("supervisor_connections")
        .select("connection_id")
        .where("connection_id", "=", f.connectionId)
        .forUpdate()
        .execute();
      locked.resolve(
        (await sql<{ pid: number }>`select pg_backend_pid() pid`.execute(tx)).rows[0]!.pid,
      );
      await release.promise;
    });
    const pid = await locked.promise;
    const reconnecting = f.reconnect().catch((error) => error);
    try {
      await vi.waitFor(async () =>
        expect(
          (
            await sql<{ n: number }>`select count(*)::int n from pg_stat_activity
        where ${pid}=any(pg_blocking_pids(pid))`.execute(db)
          ).rows[0]!.n,
        ).toBeGreaterThan(0),
      );
      // Simulate the passage of credential time while registration is blocked.
      await db
        .updateTable("supervisor_boot_credentials")
        .set({
          created_at: sql<Date>`clock_timestamp() - interval '1 hour'`,
          expires_at: sql<Date>`clock_timestamp() - interval '1 second'`,
        })
        .where("worker_id", "=", f.workerId)
        .execute();
    } finally {
      release.resolve();
      await holding;
    }
    expect(await reconnecting).toMatchObject({ code: "boot_unavailable", retryable: false });
    expect(
      (
        await db
          .selectFrom("supervisor_connections")
          .select("connection_id")
          .where("worker_id", "=", f.workerId)
          .where("state", "=", "active")
          .execute()
      ).map((c) => c.connection_id),
    ).toEqual([f.connectionId]);
  });

  it.each(["revoked", "expired", "failed"] as const)(
    "does not revive %s Boot authorization",
    async (reason) => {
      const f = await fixture();
      await f.expire();
      await f.manager.expireConnections();
      if (reason === "failed")
        await db
          .updateTable("workers")
          .set({ state: "failed" })
          .where("id", "=", f.workerId)
          .execute();
      else
        await db
          .updateTable("supervisor_boot_credentials")
          .set(
            reason === "revoked"
              ? { revoked_at: sql<Date>`clock_timestamp()` }
              : {
                  created_at: sql<Date>`clock_timestamp() - interval '1 hour'`,
                  expires_at: sql<Date>`clock_timestamp() - interval '1 second'`,
                },
          )
          .where("worker_id", "=", f.workerId)
          .execute();
      await expect(f.reconnect()).rejects.toMatchObject({ retryable: false });
      await expect(f.heartbeat()).rejects.toMatchObject({ retryable: false });
      expect(
        await db
          .selectFrom("supervisor_connections")
          .select("connection_id")
          .where("worker_id", "=", f.workerId)
          .where("state", "=", "active")
          .execute(),
      ).toEqual([]);
    },
  );

  it("rechecks a preauthenticated old Boot after a replacement provisions under the Host lock", async () => {
    const f = await fixture();
    const provisioner = new SupervisorBootProvisioner({
      database: db,
      allowedSupervisorIdPrefix: f.authority.supervisorId.slice(0, 9),
      managementBaseUrlTemplates: ["http://{supervisorId}:4100"],
      maximumCapacity: 2,
      enrollmentToken: "test-enrollment-" + "e".repeat(48),
    });
    const next = {
      protocolVersion: 1,
      type: "supervisor.boot.provision",
      requestId: randomUUID(),
      supervisorId: f.authority.supervisorId,
      bootId: randomUUID(),
      sandboxId: randomUUID(),
      credentialId: randomUUID(),
      credentialSha256: "a".repeat(64),
      maxConcurrentSessions: 2,
      managementBaseUrl: `http://${f.authority.supervisorId}:4100`,
    };
    const locked = Promise.withResolvers<number>(),
      release = Promise.withResolvers<void>();
    const holding = db.transaction().execute(async (tx) => {
      await tx
        .selectFrom("supervisor_hosts")
        .selectAll()
        .where("supervisor_id", "=", f.authority.supervisorId)
        .forUpdate()
        .execute();
      locked.resolve(
        (await sql<{ pid: number }>`select pg_backend_pid() pid`.execute(tx)).rows[0]!.pid,
      );
      await release.promise;
    });
    const pid = await locked.promise;
    const waiters = async () =>
      (
        await sql<{
          n: number;
        }>`select count(*)::int n from pg_stat_activity where datname=current_database() and pid<>${pid} and cardinality(pg_blocking_pids(pid))>0`.execute(
          db,
        )
      ).rows[0]!.n;
    let nextProvision: Promise<unknown> | undefined, oldRegistration: Promise<unknown> | undefined;
    try {
      nextProvision = provisioner.provision(next);
      await vi.waitFor(async () => expect(await waiters()).toBeGreaterThanOrEqual(1));
      oldRegistration = f.reconnect().catch((error) => error);
      await vi.waitFor(async () => expect(await waiters()).toBeGreaterThanOrEqual(2));
    } finally {
      release.resolve();
      await holding;
    }
    await nextProvision;
    expect(await oldRegistration).toMatchObject({ code: "boot_unavailable", retryable: false });
    expect(
      await db
        .selectFrom("workers")
        .select("state")
        .where("id", "=", next.sandboxId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: "provisioning" });
    const accepted = await f.manager.register(
      {
        ...f.message,
        messageId: randomUUID(),
        payload: { ...f.message.payload, bootId: next.bootId, sandboxId: next.sandboxId },
      },
      { ...f.authority, bootId: next.bootId, sandboxId: next.sandboxId, transportId: randomUUID() },
    );
    expect(accepted.payload.bootId).toBe(next.bootId);
    expect(await f.state()).toEqual({ state: "failed" });
    await expect(f.reconnect()).rejects.toMatchObject({ retryable: false });
  });

  it.each([false, true])(
    "does not confuse an unreleased Session with an idle Worker (expired=%s)",
    async (expired) => {
      const f = await fixture();
      const tenant = await createPrivateTenant(db, {
        slug: `reconnect-${randomUUID()}`,
        ownerDisplayName: "test",
      });
      const store = new ControlPlaneStore({ database: db, ...tenant });
      const project = await store.createProject({ name: "reconnect", source: { kind: "empty" } });
      const session = await store.createSession(
        project.projectId,
        project.workspaceId,
        "root",
        "elastic",
      );
      const run = await store.acceptTurn(session.sessionId, randomUUID(), { prompt: "held" });
      const started = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const executing = f
        .executor({
          async execute() {
            started.resolve();
            await release.promise;
            return { stopReason: "stop" };
          },
        })
        .dispatchRun(run.runId)
        .catch((error) => error);
      await started.promise;
      try {
        const lease = await db
          .selectFrom("session_leases")
          .selectAll()
          .where("worker_id", "=", f.workerId)
          .executeTakeFirstOrThrow();
        if (expired)
          await db
            .updateTable("session_leases")
            .set({
              acquired_at: sql<Date>`clock_timestamp() - interval '2 hours'`,
              renewed_at: sql<Date>`clock_timestamp() - interval '2 hours'`,
              valid_until: sql<Date>`clock_timestamp() - interval '1 second'`,
            })
            .where("lease_id", "=", lease.lease_id)
            .execute();
        await f.expire();
        await f.manager.expireConnections();
        if (expired) {
          expect(await f.state()).toEqual({ state: "failed" });
          expect(await f.retirement()).toHaveLength(1);
          await expect(f.reconnect()).rejects.toMatchObject({ retryable: false });
        } else {
          expect(await f.state()).toEqual({ state: "ready" });
          expect(await f.retirement()).toEqual([]);
          await f.reconnect();
          expect(
            await db
              .selectFrom("session_leases")
              .selectAll()
              .where("lease_id", "=", lease.lease_id)
              .executeTakeFirstOrThrow(),
          ).toEqual(lease);
        }
      } finally {
        release.resolve();
        await executing;
      }
    },
  );
});
