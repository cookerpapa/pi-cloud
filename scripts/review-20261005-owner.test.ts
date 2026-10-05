// Review characterization: a resource row wait blocks the shared owner's renewal.
// Run only with run-with-test-postgres.mjs; this creates/drops its own database.
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { expect, it, vi } from "vitest";
import { createDatabase, runMigrations } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { ControlPlaneStore } from "../packages/control-plane/src/control-plane-store.ts";
import { PostgresWorkspaceRuntimeStateRepository } from "../packages/sandbox-control/src/workspace-runtime-state-repository.ts";

it("characterizes one blocked allocation fencing the whole controller despite a healthy PG", async () => {
  const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
  if (!endpoint) throw new Error("A disposable PostgreSQL fixture is required");
  const name = `review_owner_${randomUUID().replaceAll("-", "")}`;
  const admin = createDatabase({ connectionString: endpoint, maxConnections: 1 });
  await sql`create database ${sql.id(name)}`.execute(admin);
  const url = new URL(endpoint);
  url.pathname = `/${name}`;
  const db = createDatabase({ connectionString: url.toString(), maxConnections: 8 });
  let repository: PostgresWorkspaceRuntimeStateRepository | undefined;
  const gate = Promise.withResolvers<void>(),
    entered = Promise.withResolvers<void>();
  let blocker: Promise<unknown> | undefined, mutation: Promise<unknown> | undefined;
  try {
    await runMigrations(db, "up");
    const tenant = await createPrivateTenant(db, {
      slug: name.replaceAll("_", "-"),
      ownerDisplayName: "Review",
    });
    const store = new ControlPlaneStore({ database: db, ...tenant });
    const instanceId = randomUUID();
    repository = new PostgresWorkspaceRuntimeStateRepository({
      database: db,
      instanceId,
      sandboxDomainId: "sandbox-domain-0001",
      ownerBaseUrl: "http://review.test",
      leaseMs: 1500,
      heartbeatMs: 100,
    });
    await repository.start();
    const ids = [randomUUID(), randomUUID()];
    for (const id of ids) {
      const project = await store.createProject({
        name: `Review ${id}`,
        source: { kind: "empty" },
      });
      const session = await store.createSession(
        project.projectId,
        project.workspaceId,
        "Review",
        "elastic",
      );
      const run = await store.acceptTurn(session.sessionId, randomUUID(), { prompt: "review" });
      await db
        .insertInto("workspace_runtimes")
        .values({
          workspace_runtime_id: id,
          allocation_protocol: 1,
          tenant_id: tenant.tenantId,
          project_id: project.projectId,
          workspace_id: project.workspaceId,
          sandbox_domain_id: "sandbox-domain-0001",
          owner_instance_id: instanceId,
          owner_base_url: "http://review.test",
          supervisor_id: "review",
          boot_id: randomUUID(),
          sandbox_id: randomUUID(),
          run_id: run.runId,
          session_id: session.sessionId,
          turn_id: run.turnId,
          lease_id: randomUUID(),
          fencing_token: "1",
          turn_context_sha256: "a".repeat(64),
          execution_context_sha256: "b".repeat(64),
          environment_sha256: "c".repeat(64),
          runtime_id: null,
          runtime_name: null,
          state: "materializing",
          failure_code: null,
        })
        .execute();
    }
    blocker = db.transaction().execute(async (tx) => {
      await tx
        .selectFrom("workspace_runtimes")
        .select("workspace_runtime_id")
        .where("workspace_runtime_id", "=", ids[0]!)
        .forUpdate()
        .execute();
      entered.resolve();
      await gate.promise;
    });
    await entered.promise;
    mutation = repository.closeAllocation(ids[0]!, "workspace").catch((e) => e);
    await vi.waitFor(async () => {
      const waits = await sql<{ n: number }>`select count(*)::int n from pg_stat_activity
        where datname=current_database() and wait_event_type='Lock'`.execute(db);
      expect(waits.rows[0]!.n).toBeGreaterThanOrEqual(2);
    });
    await vi.waitFor(
      async () => {
        const owner = await sql<{
          expired: boolean;
        }>`select lease_expires_at<=clock_timestamp() expired
        from sandbox_control_instances where instance_id=${instanceId}::uuid`.execute(db);
        expect(owner.rows[0]!.expired).toBe(true);
      },
      { timeout: 4000 },
    );
    // Even an unrelated allocation can no longer be admitted under this owner.
    expect(() => repository!.assertLocalOwnership()).toThrow();
    gate.resolve();
    await blocker;
    expect(await mutation).toMatchObject({ code: "ownership_lost" });
    await expect(repository.closeAllocation(ids[1]!, "workspace")).rejects.toMatchObject({
      code: "ownership_lost",
    });
    await expect(repository.checkHealth()).rejects.toMatchObject({ code: "ownership_lost" });
  } finally {
    gate.resolve();
    await blocker;
    await mutation;
    await repository?.close();
    await db.destroy();
    await sql`drop database ${sql.id(name)}`.execute(admin);
    await admin.destroy();
  }
}, 20000);
