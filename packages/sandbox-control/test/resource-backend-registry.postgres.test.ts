import { createPrivateTenant } from "../../control-plane/src/tenant-administration.ts";
import { ControlPlaneStore } from "../../control-plane/src/control-plane-store.ts";
import { DevelopmentEnvironmentService } from "../../control-plane/src/development-environment-service.ts";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { ResourceBackendRegistry } from "../src/resource-backend-registry.ts";
import type { ResourceBackendConfiguration } from "@pi-cloud/protocol";

const configuration = (endpoint: string): ResourceBackendConfiguration => ({
  compute: { provider: "boxlite", url: endpoint, nodeId: "owned-node", token: "private-token" },
  storage: { url: "http://storage:4500", token: "private-storage-token", poolId: "owned-pool" },
  webProxy: { host: "10.255.255.254", port: 3128, directPrivateCidrs: [] },
  templates: [
    {
      id: "linux",
      name: "Linux",
      operatingSystem: "Ubuntu 24.04",
      imageRevision: "fixed-guest",
      elasticTemplateId: "tool",
      profiles: { starter: "starter", standard: "standard", performance: "performance" },
    },
  ],
});

it("updates display metadata with allocated intent while preserving template mutation guards", async () => {
  const db = createDatabase({
    connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!,
    maxConnections: 2,
  });
  try {
    await runMigrations(db, "up");
    const registry = new ResourceBackendRegistry({
      database: db,
      key: Buffer.alloc(32, 9),
      managementBaseUrl: "http://management:4300",
      verify: async () => "owned-pool",
    });
    const id = randomUUID();
    const request = {
      id,
      name: "Display backend",
      location: "Local",
      state: "active",
      expectedRevision: 0,
      configuration: configuration(`http://box-${id}:8091`),
    };
    await registry.put(request);
    const tenant = await createPrivateTenant(db, {
      slug: randomUUID(),
      ownerDisplayName: "Display owner",
    });
    const service = new DevelopmentEnvironmentService({
      database: db,
      terminalToken: "owned-fixture-".repeat(3),
      allowInsecureInternalHttp: true,
    });
    const machine = await service.create(
      {
        credentialId: tenant.credential.credentialId,
        tenantId: tenant.tenantId,
        tenantSlug: tenant.tenantSlug,
        userId: tenant.ownerUserId,
        displayName: "Display owner",
        role: "owner",
        defaultModelProfileId: tenant.defaultModelProfileId,
      },
      "owned-pending-machine",
      {
        name: "Pending machine",
        profileKey: "starter",
        backend: { id, revision: 1, templateId: "linux" },
      },
    );
    const before = await db
      .selectFrom("development_environments")
      .selectAll()
      .where("id", "=", machine.environmentId)
      .executeTakeFirstOrThrow();
    const renamed = structuredClone(request.configuration);
    renamed.templates[0]!.name = "Fixed Guest";
    renamed.templates[0]!.operatingSystem = "Linux";
    expect(
      (await registry.put({ ...request, expectedRevision: 1, configuration: renamed })).revision,
    ).toBe(2);
    expect(
      await db
        .selectFrom("development_environments")
        .selectAll()
        .where("id", "=", machine.environmentId)
        .executeTakeFirstOrThrow(),
    ).toEqual(before);
    for (const field of ["imageRevision", "elasticTemplateId"] as const) {
      const changed = structuredClone(renamed);
      changed.templates[0]![field] += "-changed";
      await expect(
        registry.put({ ...request, expectedRevision: 2, configuration: changed }),
      ).rejects.toThrow("retained resources");
    }
  } finally {
    await db.destroy();
  }
});

it("registers two native backends behind one existing management endpoint, encrypts credentials and rejects stale edits", async () => {
  const db = createDatabase({
    connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!,
    maxConnections: 2,
  });
  try {
    await runMigrations(db, "up");
    const verify = vi.fn(async () => "owned-pool");
    const registry = new ResourceBackendRegistry({
      database: db,
      key: Buffer.alloc(32, 9),
      managementBaseUrl: "http://management:4300",
      verify,
    });
    const id = randomUUID(),
      secondId = randomUUID();
    const request = {
      id,
      name: "Owned backend",
      location: "Local",
      state: "active",
      expectedRevision: 0,
      configuration: configuration(`http://box-${id}:8091`),
    };
    const first = await registry.put(request);
    expect(first.revision).toBe(1);
    expect(JSON.stringify(first)).not.toContain("private-");
    expect(await registry.put(request)).toEqual(first);
    await registry.put({
      ...request,
      id: secondId,
      configuration: configuration(`http://box-${secondId}:8091`),
    });
    const tenant = await createPrivateTenant(db, {
      slug: randomUUID(),
      ownerDisplayName: "Backend holder",
    });
    const project = await new ControlPlaneStore({ database: db, ...tenant }).createProject({
      name: "Retained Workspace",
      source: { kind: "empty" },
    });
    await db
      .updateTable("workspaces")
      .set({ sandbox_domain_id: id, backend_template_id: "linux" })
      .where("id", "=", project.workspaceId)
      .execute();
    await expect(
      registry.put({
        ...request,
        expectedRevision: 1,
        configuration: configuration("http://other-cluster:8091"),
      }),
    ).rejects.toThrow("retained resources");
    const saved = await db
      .selectFrom("sandbox_domains")
      .select(["backend_configuration", "backend_endpoint"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    expect(saved.backend_configuration).not.toContain("private-token");
    expect(
      (await registry.list()).find((b) => b.resource.id === id)?.configuration.compute,
    ).toEqual(request.configuration.compute);
    await expect(registry.put({ ...request, name: "Stale overwrite" })).rejects.toThrow(
      "revision changed",
    );
    const disabled = await registry.put({
      id,
      name: request.name,
      location: "Local",
      state: "disabled",
      expectedRevision: 1,
    });
    expect(disabled.revision).toBe(2);
    const calls = verify.mock.calls.length;
    await registry.put({
      id,
      name: "Renamed disabled",
      location: "Local",
      state: "disabled",
      expectedRevision: 2,
    });
    expect(verify).toHaveBeenCalledTimes(calls);
    await expect(registry.put({ ...request, id: randomUUID() })).rejects.toThrow(); // same physical endpoint cannot acquire a second identity
    verify.mockRejectedValueOnce(new Error("native protocol mismatch"));
    await expect(
      registry.put({
        id,
        name: request.name,
        location: "Local",
        state: "active",
        expectedRevision: 3,
      }),
    ).rejects.toThrow("protocol mismatch");
    expect((await registry.list()).find((b) => b.resource.id === id)?.resource.state).toBe(
      "disabled",
    );
  } finally {
    await db.destroy();
  }
});
