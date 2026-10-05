// Real PG failure isolation: slow resource work must not revoke a healthy owner.
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { expect, it, vi } from "vitest";
import { createDatabase, runMigrations } from "../../database/src/index.ts";
import { createPrivateTenant } from "../../control-plane/src/tenant-administration.ts";
import { ControlPlaneStore } from "../../control-plane/src/control-plane-store.ts";
import { PostgresWorkspaceRuntimeStateRepository } from "../src/workspace-runtime-state-repository.ts";

it.each(["workspace", "terminal"] as const)(
  "renews its owner and serves another Workspace while a %s row stays locked",
  async (kind) => {
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
        leaseMs: 2000,
        heartbeatMs: 100,
      });
      await repository.start();
      const ids = [randomUUID(), randomUUID()];
      let terminalId: string | undefined;
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
        if (kind === "terminal" && id === ids[0]) {
          terminalId = randomUUID();
          expect(
            await repository.reserveTerminal({
              terminalId,
              tenantId: tenant.tenantId,
              userId: tenant.ownerUserId,
              projectId: project.projectId,
              workspaceId: project.workspaceId,
              sessionId: session.sessionId,
            }),
          ).toMatchObject({ status: "reserved" });
        }
      }
      blocker = db.transaction().execute(async (tx) => {
        if (terminalId)
          await tx
            .selectFrom("workspace_terminal_sessions")
            .select("terminal_id")
            .where("terminal_id", "=", terminalId)
            .forUpdate()
            .execute();
        else
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
      const started = Date.now();
      if (kind === "workspace") {
        mutation = repository.closeAllocation(ids[0]!, "workspace").catch((e) => e);
        expect(await mutation).toMatchObject({ code: "unavailable" });
        const held = await db
          .selectFrom("workspace_runtimes")
          .select("allocation_closed")
          .where("workspace_runtime_id", "=", ids[0]!)
          .executeTakeFirstOrThrow();
        expect(held.allocation_closed).toBe(false);
      }
      await vi.waitFor(
        async () => {
          const owner = await db
            .selectFrom("sandbox_control_instances")
            .select(["state", "last_heartbeat_at"])
            .where("instance_id", "=", instanceId)
            .executeTakeFirstOrThrow();
          expect(owner.state).toBe("ready");
          expect(new Date(owner.last_heartbeat_at).valueOf()).toBeGreaterThan(started + 2000);
        },
        { timeout: 4500, interval: 50 },
      );
      expect(() => repository!.assertLocalOwnership()).not.toThrow();
      await expect(repository.closeAllocation(ids[1]!, "workspace")).resolves.toMatchObject({
        status: "never_issued",
      });
      await expect(repository.checkHealth()).resolves.toBeUndefined();
      gate.resolve();
      await blocker;
      await expect(repository.closeAllocation(ids[0]!, "workspace")).resolves.toMatchObject({
        status: "never_issued",
      });
    } finally {
      gate.resolve();
      await blocker;
      await mutation;
      await repository?.close();
      await db.destroy();
      await sql`drop database ${sql.id(name)}`.execute(admin);
      await admin.destroy();
    }
  },
  20000,
);
