// Real PG characterization: retire the owner between its read and resource write.
import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { sql } from "kysely";
import { createDatabase, runMigrations } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { ControlPlaneStore } from "../packages/control-plane/src/control-plane-store.ts";
import { PostgresWorkspaceRuntimeStateRepository } from "../packages/sandbox-control/src/workspace-runtime-state-repository.ts";
import { CUBESANDBOX_TOOL_POLICY } from "../packages/sandbox-control/src/cubesandbox-sandbox-provider.ts";
import {
  createExecutionReference,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
  DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
  DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
} from "@pi-cloud/protocol";

it.each(["create", "close"] as const)(
  "characterizes %s admission after the controller owner has been retired",
  async (action) => {
    const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
    if (!endpoint) throw Error("Use run-with-test-postgres.mjs");
    const admin = createDatabase({ connectionString: endpoint, maxConnections: 1 }),
      name = "review_owner_" + randomUUID().replaceAll("-", "");
    await sql`create database ${sql.id(name)}`.execute(admin);
    const url = new URL(endpoint);
    url.pathname = "/" + name;
    const db = createDatabase({ connectionString: url.toString(), maxConnections: 4 });
    let repository: PostgresWorkspaceRuntimeStateRepository | undefined;
    try {
      await runMigrations(db, "up");
      const instanceId = randomUUID(),
        id = randomUUID();
      let armed = false,
        retired = false;
      const traced = db.withPlugin({
        transformQuery: (a) => a.node,
        async transformResult(a) {
          if (
            armed &&
            a.result.rows.some((r) => (r as { instance_id?: string }).instance_id === instanceId)
          ) {
            armed = false;
            await sql`update sandbox_control_instances set state='lost',lease_expires_at=clock_timestamp()-interval '1 second' where instance_id=${instanceId}::uuid`.execute(
              db,
            );
            await sql`update workspace_runtimes set state='unknown',failure_code='tool_broker_owner_lost' where workspace_runtime_id=${id}::uuid`.execute(
              db,
            );
            retired = true;
          }
          return a.result;
        },
      });
      repository = new PostgresWorkspaceRuntimeStateRepository({
        database: traced,
        instanceId,
        sandboxDomainId: "sandbox-domain-0001",
        ownerBaseUrl: "http://owner-review.test",
      });
      await repository.start();
      const tenant = await createPrivateTenant(db, {
        slug: name.replaceAll("_", "-"),
        ownerDisplayName: "Review",
      });
      const store = new ControlPlaneStore({ database: db, ...tenant });
      const p = await store.createProject({ name: "Review", source: { kind: "empty" } }),
        s = await store.createSession(p.projectId, p.workspaceId, "Review", "elastic"),
        r = await store.acceptTurn(s.sessionId, randomUUID(), { prompt: "review" });
      const lease = randomUUID();
      const assignment = {
        tenantId: tenant.tenantId,
        projectId: p.projectId,
        workspaceId: p.workspaceId,
        supervisorId: "review",
        bootId: randomUUID(),
        sandboxId: randomUUID(),
        runId: r.runId,
        sessionId: s.sessionId,
        turnId: r.turnId,
        executionReference: createExecutionReference(lease, r.runId, 1),
      };
      await db
        .insertInto("workspace_runtimes")
        .values({
          workspace_runtime_id: id,
          allocation_protocol: 1,
          tenant_id: tenant.tenantId,
          project_id: p.projectId,
          workspace_id: p.workspaceId,
          sandbox_domain_id: "sandbox-domain-0001",
          owner_instance_id: instanceId,
          owner_base_url: "http://owner-review.test",
          supervisor_id: assignment.supervisorId,
          boot_id: assignment.bootId,
          sandbox_id: assignment.sandboxId,
          run_id: r.runId,
          session_id: s.sessionId,
          turn_id: r.turnId,
          lease_id: lease,
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
      const spec = {
        activationId: id,
        assignment,
        workspaceSeed: { kind: "sample_java" as const },
        policy: CUBESANDBOX_TOOL_POLICY,
        environment: {
          environmentVersionId: p.environment.environmentVersionId,
          versionNumber: 1,
          profileKey: "pi-cloud-fullstack" as const,
          profileVersion: "1" as const,
          imageRevision: "review",
          specSha256: DEFAULT_PROJECT_ENVIRONMENT_SPEC_SHA256,
          recipe: DEFAULT_PROJECT_ENVIRONMENT_RECIPE,
          recipeSha256: DEFAULT_PROJECT_ENVIRONMENT_RECIPE_SHA256,
        },
      };
      if (action === "close") await repository.beginCreation(spec);
      armed = true;
      const result =
        action === "create"
          ? await repository.beginCreation(spec)
          : await repository.closeAllocation(id, "workspace");
      expect(retired).toBe(true);
      expect(result).toBeDefined();
      const owner = await db
        .selectFrom("sandbox_control_instances")
        .select("state")
        .where("instance_id", "=", instanceId)
        .executeTakeFirstOrThrow();
      expect(owner.state).toBe("lost");
      const allocation = await db
        .selectFrom("workspace_runtimes")
        .select(["creation_not_after", "allocation_closed"])
        .where("workspace_runtime_id", "=", id)
        .executeTakeFirstOrThrow();
      expect(allocation.creation_not_after).not.toBeNull();
      expect(allocation.allocation_closed).toBe(action === "close");
    } finally {
      await repository?.close();
      await db.destroy();
      await sql`drop database ${sql.id(name)}`.execute(admin);
      await admin.destroy();
    }
  },
  30000,
);
