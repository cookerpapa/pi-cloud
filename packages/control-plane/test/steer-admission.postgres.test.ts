import { admitTestExecution } from "./admit-test-execution.ts";
import { randomUUID } from "node:crypto";
import { Pool, type PoolClient } from "pg";
import { sql, type QueryId } from "kysely";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { RunExecutor } from "@pi-cloud/runtime-core/run-executor";
import { SessionLeaseCoordinator } from "@pi-cloud/runtime-core/session-lease-coordinator";
import { expect, it } from "vitest";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { TurnSteeringService } from "../src/turn-steering-service.ts";
import type { TenantRequestIdentity } from "../src/tenant-identity.ts";

const external = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;

it.skipIf(!external)(
  "Steer admission remains compatible with concurrent Tool binding foreign keys",
  async () => {
    const administrator = new Pool({ connectionString: external, max: 1 });
    const name = `steer_admission_${randomUUID().replaceAll("-", "")}`;
    await administrator.query(`create database "${name}"`);
    const url = new URL(external!);
    url.pathname = `/${name}`;
    url.searchParams.set("options", "-c lock_timeout=1000 -c statement_timeout=5000");
    const database = createDatabase({ connectionString: url.toString(), maxConnections: 5 });
    const fkPool = new Pool({ connectionString: url.toString(), max: 1 });
    const running = Promise.withResolvers<void>();
    const finishRun = Promise.withResolvers<void>();
    const targetLocked = Promise.withResolvers<{ error?: unknown }>();
    const releaseTarget = Promise.withResolvers<void>();
    let execution: Promise<unknown> | undefined;
    let delivery: Promise<unknown> | undefined;
    let fk: PoolClient | undefined;
    try {
      await runMigrations(database, "up");
      const tenant = await createPrivateTenant(database, {
        slug: "steer",
        ownerDisplayName: "Steer fixture",
      });
      const store = new ControlPlaneStore({
        database,
        tenantId: tenant.tenantId,
        defaultModelProfileId: tenant.defaultModelProfileId,
      });
      const project = await store.createProject({ name: "steer", source: { kind: "empty" } });
      await database
        .updateTable("environment_versions")
        .set({ state: "validated", validated_at: new Date() })
        .where("id", "=", project.environment.environmentVersionId)
        .execute();
      const session = await store.createSession(
        project.projectId,
        project.workspaceId,
        "steer",
        "elastic",
      );
      const accepted = await store.acceptTurn(session.sessionId, "run", { prompt: "fixture" });
      const sandboxId = randomUUID();
      await database
        .insertInto("sandboxes")
        .values({
          id: sandboxId,
          supervisor_id: "steer-worker",
          boot_id: randomUUID(),
          state: "ready",
          max_concurrent_sessions: 1,
          active_sessions: 0,
        })
        .execute();
      const authority = new SessionLeaseCoordinator({
        database,
        sandboxId,
        leaseDurationMs: 60_000,
      });
      const executor = new RunExecutor({
        database,
        claimOwnerId: "steer-worker",
        executionAuthority: authority,
        backend: {
          admit: (tx, request) => admitTestExecution(authority, tx, request),
          async execute() {
            running.resolve();
            await finishRun.promise;
            return { stopReason: "stop" };
          },
        },
      });
      execution = executor.dispatchRun(accepted.runId);
      void execution.catch((error) => running.reject(error));
      await running.promise;

      // Match the Run/Session reference checks of a binding INSERT. PostgreSQL,
      // not a mock mutex, owns these KEY SHARE locks on the real lifecycle rows.
      await sql`create table binding_fk_probe(run_id uuid references runs(id), session_id uuid references sessions(id))`.execute(
        database,
      );
      fk = await fkPool.connect();
      await fk.query("begin");
      await fk.query("select id from runs where id=$1 for key share", [accepted.runId]);
      const targets = new WeakSet<QueryId>();
      const observed = database.withPlugin({
        transformQuery({ node, queryId }) {
          if (
            database
              .getExecutor()
              .compileQuery(node, queryId)
              .sql.startsWith('select "turn"."state" as "turnState"')
          )
            targets.add(queryId);
          return node;
        },
        async transformResult({ result, queryId }) {
          if (targets.has(queryId)) {
            targetLocked.resolve({});
            await releaseTarget.promise;
          }
          return result;
        },
      });
      let deliveries = 0;
      const steer = new TurnSteeringService({
        database: observed,
        backendFactory: async () => ({
          steer: async () => {
            deliveries++;
          },
        }),
      });
      delivery = steer
        .deliver(
          { tenantId: tenant.tenantId } as TenantRequestIdentity,
          session.sessionId,
          accepted.turnId,
          "steer",
          { text: "new direction" },
        )
        .catch((error) => {
          targetLocked.resolve({ error });
          throw error;
        });
      void delivery.catch(() => {});
      expect(await targetLocked.promise).toEqual({});
      await fk.query("insert into binding_fk_probe values($1,$2)", [
        accepted.runId,
        session.sessionId,
      ]);
      await fk.query("commit");
      releaseTarget.resolve();
      await expect(delivery).resolves.toMatchObject({ state: "delivered" });
      expect(deliveries).toBe(1);
    } finally {
      releaseTarget.resolve();
      if (fk) {
        await fk.query("rollback");
        fk.release();
      }
      await delivery?.catch(() => {});
      finishRun.resolve();
      await execution;
      await fkPool.end();
      await database.destroy();
      await administrator.query(`drop database "${name}"`);
      await administrator.end();
    }
  },
  30_000,
);
