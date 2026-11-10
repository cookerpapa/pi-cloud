import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { sql } from "kysely";
import { createDatabase, runMigrations } from "../../packages/database/src/index.ts";
import { createPrivateTenant } from "../../packages/control-plane/src/tenant-administration.ts";
import { ControlPlaneStore } from "../../packages/control-plane/src/control-plane-store.ts";
import { DevelopmentEnvironmentService } from "../../packages/control-plane/src/development-environment-service.ts";
import { CubePersistentCapsuleCodec } from "../../packages/sandbox-control/src/cube-persistent-capsule.ts";
import { PostgresWorkspaceRuntimeStateRepository } from "../../packages/sandbox-control/src/workspace-runtime-state-repository.ts";
import { CUBESANDBOX_TOOL_POLICY } from "../../packages/sandbox-control/src/cubesandbox-sandbox-provider.ts";
import { createComputeRetirementRepository } from "./compute-retirement-postgres.mjs";
import { maintenanceMachineRetired, retireComputeForMaintenance } from "./compute-retirement.mjs";

const postgres = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;

it.skipIf(!postgres)(
  "uses actual PG fences, preserves two Workspaces, and resumes a retired paused machine through normal recovery",
  async () => {
    const name = `maintenance_${randomUUID().replaceAll("-", "")}`;
    const admin = createDatabase({ connectionString: postgres, maxConnections: 1 });
    let database, recovery;
    try {
      await sql`create database ${sql.id(name)}`.execute(admin);
      const endpoint = new URL(postgres);
      endpoint.pathname = `/${name}`;
      database = createDatabase({ connectionString: endpoint.toString(), maxConnections: 4 });
      await runMigrations(database, "up");
      const tenant = await createPrivateTenant(database, {
        slug: name.replaceAll("_", "-"),
        ownerDisplayName: "Maintenance fixture",
      });
      const store = new ControlPlaneStore({ database, ...tenant });
      const owner = randomUUID(),
        machines = [],
        codec = new CubePersistentCapsuleCodec(Buffer.alloc(32, 7));
      const domain = "sandbox-domain-0001";
      await database
        .insertInto("sandbox_control_instances")
        .values({
          instance_id: owner,
          sandbox_domain_id: domain,
          owner_base_url: "http://old-owner.test",
          state: "ready",
          lease_expires_at: new Date(Date.now() + 60_000),
          last_heartbeat_at: new Date(),
        })
        .execute();
      for (const desired of ["running", "paused"]) {
        const project = await store.createProject({
          name: `Retained ${desired}`,
          source: { kind: "empty" },
        });
        await database
          .updateTable("workspaces")
          .set({ workspace_kind: "development_environment" })
          .where("id", "=", project.workspaceId)
          .execute();
        const id = randomUUID(),
          allocation = randomUUID(),
          runtime = randomUUID();
        const assignment = {
          tenantId: tenant.tenantId,
          projectId: project.projectId,
          workspaceId: project.workspaceId,
        };
        const spec = {
          activationId: allocation,
          assignment,
          environment: project.environment,
          policy: CUBESANDBOX_TOOL_POLICY,
          workspaceSeed: { kind: "bundle", bundle: "owned-fixture" },
        };
        const row = await database
          .insertInto("development_environments")
          .values({
            id,
            allocation_id: allocation,
            tenant_id: tenant.tenantId,
            owner_user_id: tenant.ownerUserId,
            project_id: project.projectId,
            workspace_id: project.workspaceId,
            sandbox_domain_id: domain,
            environment_version_id: project.environment.environmentVersionId,
            owner_instance_id: owner,
            owner_base_url: "http://old-owner.test",
            profile_key: "standard",
            cpu_count: 2,
            memory_mib: 4096,
            system_disk_gib: 20,
            runtime_id: runtime,
            runtime_name: allocation.replaceAll("-", ""),
            state: "ready",
            desired_state: desired,
            idempotency_key: randomUUID(),
            request_sha256: "a".repeat(64),
            creation_spec: spec,
            // The original native request remains immutable during retirement.
            provider_create_started_at: sql`clock_timestamp()`,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        const capsule = codec.seal({
          version: 3,
          handle: {
            activationId: allocation,
            providerApiVersion: 1,
            providerId: "cubesandbox",
            runtimeId: runtime,
            runtimeName: row.runtime_name,
            assignment,
          },
          executionTarget: { sandboxId: row.runtime_name, nodeId: "owned-node" },
        });
        await database
          .updateTable("development_environments")
          .set({ runtime_capsule: capsule })
          .where("id", "=", id)
          .execute();
        machines.push({ ...row, runtime_capsule: capsule });
      }
      const workspaceBefore = await database
        .selectFrom("workspaces")
        .selectAll()
        .orderBy("id")
        .execute();
      const repository = createComputeRetirementRepository(database);
      await expect(repository.assertDrained()).rejects.toThrow("leases");
      await database
        .updateTable("sandbox_control_instances")
        .set({ lease_expires_at: sql`clock_timestamp()-interval '1 second'` })
        .where("instance_id", "=", owner)
        .execute();
      const stale = (await repository.listTargets())[0];
      await repository.beginClose(stale);
      await database
        .updateTable("development_environments")
        .set({ intent_revision: sql`intent_revision+1` })
        .where("id", "=", stale.id)
        .execute();
      await expect(repository.finishClose(stale)).rejects.toThrow("ownership changed");
      expect(
        (
          await database
            .selectFrom("development_environments")
            .select("runtime_capsule")
            .where("id", "=", stale.id)
            .executeTakeFirstOrThrow()
        ).runtime_capsule,
      ).toBe(stale.capsule);
      const native = { async destroy() {} };
      await retireComputeForMaintenance({
        repository,
        native,
        assertProcessesStopped: async () => {},
        openCapsule: (body) => codec.open(body),
      });
      const retired = await database
        .selectFrom("development_environments")
        .selectAll()
        .orderBy("id")
        .execute();
      expect(retired.every(maintenanceMachineRetired)).toBe(true);
      expect(await database.selectFrom("workspaces").selectAll().orderBy("id").execute()).toEqual(
        workspaceBefore,
      );
      for (const row of retired) {
        const before = machines.find((machine) => machine.id === row.id);
        for (const field of [
          "id",
          "workspace_id",
          "desired_state",
          "allocation_id",
          "generation",
          "creation_spec",
          "provider_create_started_at",
          "owner_instance_id",
        ])
          expect(row[field]).toEqual(before[field]);
      }
      const paused = retired.find((row) => row.desired_state === "paused");
      const identity = { tenantId: tenant.tenantId, userId: tenant.ownerUserId };
      // HTTP is deliberately disallowed: Resume commits intent even while its
      // old controller is unavailable; this test never connects to a live owner.
      const service = new DevelopmentEnvironmentService({
        database,
        terminalToken: "owned-maintenance-token-" + "x".repeat(32),
        allowInsecureInternalHttp: false,
      });
      expect(await service.get(identity, paused.id)).toMatchObject({
        desiredState: "paused",
        state: "unknown",
      });
      await database
        .updateTable("sandbox_control_instances")
        .set({ state: "stopped", lease_expires_at: sql`clock_timestamp()` })
        .where("instance_id", "=", owner)
        .execute();
      recovery = new PostgresWorkspaceRuntimeStateRepository({
        database,
        sandboxDomainId: domain,
        instanceId: randomUUID(),
        ownerBaseUrl: "http://replacement-owner.test",
      });
      await recovery.start();
      // A closed, absent paused allocation has no orphaned runtime to diagnose.
      // Starting replacement ownership must not stamp a false owner-loss failure.
      expect(
        await database
          .selectFrom("development_environments")
          .select([
            "desired_state",
            "allocation_closed",
            "allocation_absent",
            "failure_code",
            "owner_instance_id",
          ])
          .where("id", "=", paused.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({
        desired_state: "paused",
        allocation_closed: true,
        allocation_absent: true,
        failure_code: null,
        owner_instance_id: owner,
      });
      const automatic = await recovery.claimRecoverableDevelopmentEnvironments(10, []);
      expect(automatic.map((item) => item.reservation.environmentId)).not.toContain(paused.id);
      expect(automatic.some((item) => item.reservation.desiredState === "running")).toBe(true);
      expect(
        await service.action(identity, paused.id, randomUUID(), { action: "resume" }),
      ).toMatchObject({
        environmentId: paused.id,
        workspaceId: paused.workspace_id,
        desiredState: "running",
        state: "recovering",
      });
      const candidate = (await recovery.claimRecoverableDevelopmentEnvironments(10, [])).find(
        (item) => item.reservation.environmentId === paused.id,
      );
      expect(candidate.allocationAbsent).toBe(true);
      const next = randomUUID();
      const replaced = await recovery.replaceDevelopmentEnvironmentAllocation(
        candidate.reservation,
        { ...candidate.creation.spec, activationId: next },
      );
      expect(replaced).toMatchObject({
        environmentId: paused.id,
        workspaceId: paused.workspace_id,
        allocationId: next,
        generation: Number(paused.generation) + 1,
      });
      expect(next).not.toBe(paused.allocation_id);
      expect(await database.selectFrom("workspaces").selectAll().orderBy("id").execute()).toEqual(
        workspaceBefore,
      );
      await service.close();
    } finally {
      await recovery?.close();
      await database?.destroy();
      await sql`drop database if exists ${sql.id(name)}`.execute(admin);
      await admin.destroy();
    }
  },
  60_000,
);
