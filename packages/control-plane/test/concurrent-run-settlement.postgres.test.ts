import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { RunExecutor } from "@pi-cloud/runtime-core/run-executor";
import { SessionLeaseCoordinator } from "@pi-cloud/runtime-core/session-lease-coordinator";
import { expect, it } from "vitest";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { createPrivateTenant } from "../src/tenant-administration.ts";

const external = process.env.PI_CLOUD_PI_SESSION_CONFORMANCE_DATABASE_URL;

// CI supplies a dedicated PostgreSQL owner. PGlite cannot certify row-lock concurrency.
it.skipIf(!external)(
  "settles concurrent Runs on one Worker without FK lock-upgrade retries",
  async () => {
    const admin = new Pool({ connectionString: external, max: 1 });
    const name = `pi_settlement_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database "${name}"`);
    const url = new URL(external!);
    url.pathname = `/${name}`;
    const db = createDatabase({ connectionString: url.toString(), maxConnections: 8 });
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let arrivals = 0;
    let timer: NodeJS.Timeout | undefined;
    try {
      await runMigrations(db, "up");
      const tenant = await createPrivateTenant(db, {
        slug: "settlement",
        ownerDisplayName: "Settlement",
      });
      const store = new ControlPlaneStore({
        database: db,
        tenantId: tenant.tenantId,
        defaultModelProfileId: tenant.defaultModelProfileId,
      });
      const project = await store.createProject({ name: "settlement", source: { kind: "empty" } });
      await db
        .updateTable("environment_versions")
        .set({ state: "validated", validated_at: new Date() })
        .where("id", "=", project.environment.environmentVersionId)
        .execute();
      const sessions = await Promise.all(
        [0, 1].map((i) =>
          store.createSession(project.projectId, project.workspaceId, `s${i}`, "elastic"),
        ),
      );
      const turns = await Promise.all(
        sessions.map((s, i) => store.acceptTurn(s.sessionId, `t${i}`, { prompt: "test" })),
      );
      const sandboxId = randomUUID();
      await db
        .insertInto("sandboxes")
        .values({
          id: sandboxId,
          supervisor_id: "settlement-worker",
          boot_id: randomUUID(),
          state: "ready",
          max_concurrent_sessions: 16,
          active_sessions: 0,
        })
        .execute();
      const seals = new WeakSet<object>();
      const measured = db.withPlugin({
        transformQuery({ node, queryId }) {
          if (db.getExecutor().compileQuery(node, queryId).sql.startsWith('insert into "outbox"'))
            seals.add(queryId);
          return node;
        },
        async transformResult({ result, queryId }) {
          if (seals.has(queryId)) {
            if (++arrivals === 2) release();
            await barrier;
          }
          return result;
        },
      });
      const coordinator = new SessionLeaseCoordinator({
        database: measured,
        sandboxId,
        leaseDurationMs: 60_000,
      });
      let executions = 0;
      const executor = new RunExecutor({
        database: measured,
        claimOwnerId: "settlement-worker",
        executionAuthority: coordinator,
        backend: {
          async execute(request, lifecycle) {
            executions++;
            const lease = await coordinator.acquire(request);
            await lifecycle.started(lease);
            return { stopReason: "stop" };
          },
        },
      });
      timer = setTimeout(release, 10_000);
      const results = await Promise.allSettled(turns.map((t) => executor.dispatchRun(t.runId)));
      expect(results).toEqual(
        turns.map(() => ({
          status: "fulfilled",
          value: expect.objectContaining({ status: "completed" }),
        })),
      );
      expect(executions).toBe(2);
      // A deadlock retried by retryTransaction would attempt a third seal INSERT.
      expect(arrivals).toBe(2);
      expect(
        await db
          .selectFrom("sandboxes")
          .select(["state", "active_sessions"])
          .where("id", "=", sandboxId)
          .executeTakeFirst(),
      ).toEqual({ state: "ready", active_sessions: 0 });
      expect(await db.selectFrom("session_leases").select("lease_id").execute()).toEqual([]);
      expect(await db.selectFrom("outbox").select("id").execute()).toHaveLength(2);
    } finally {
      clearTimeout(timer);
      release();
      await db.destroy();
      await admin.query(`drop database "${name}"`);
      await admin.end();
    }
  },
  30_000,
);
