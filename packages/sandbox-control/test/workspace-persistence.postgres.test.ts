import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { expect, it, vi } from "vitest";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { createPrivateTenant } from "../../control-plane/src/tenant-administration.ts";
import { ControlPlaneStore } from "../../control-plane/src/control-plane-store.ts";
import { PostgresWorkspacePersistence } from "../src/postgres-workspace-persistence.ts";
import { workspaceVolumeId } from "../src/workspace-volume-gateway-contract.ts";
import { requireRetainedWorkspace } from "../src/workspace-persistence.ts";
import type { WorkspaceStorageSnapshot } from "../src/workspace-quota-client.ts";

async function fixture() {
  const connectionString = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!;
  const database = createDatabase({ connectionString, maxConnections: 2 });
  const pg = new Pool({ connectionString, max: 2 });
  await runMigrations(database, "up");
  const tenant = await createPrivateTenant(database, {
    slug: randomUUID(),
    ownerDisplayName: "Storage fixture",
  });
  const project = await new ControlPlaneStore({ database, ...tenant }).createProject({
    name: "Storage",
    source: { kind: "empty" },
  });
  const identity = {
    tenantId: tenant.tenantId,
    workspaceId: project.workspaceId,
    sessionId: randomUUID(),
    volumeId: workspaceVolumeId({ tenantId: tenant.tenantId, workspaceId: project.workspaceId }),
  };
  await pg.query(
    `update sandbox_domains set storage_pool_id='owned-pool' where id=(select sandbox_domain_id from workspaces where id=$1::uuid)`,
    [project.workspaceId],
  );
  let state: WorkspaceStorageSnapshot = {
    volumeId: identity.volumeId,
    poolId: "owned-pool",
    exists: false,
    known: false,
    ready: false,
  };
  const prepare = vi.fn(async (request: { generation: string }) => {
    state = { ...state, generation: request.generation, exists: true, known: true, ready: true };
    return { ...state };
  });
  const destroy = vi.fn(async () => {
    state = { ...state, ready: false };
  });
  const files = {
    verify: vi.fn(async () => ({ verified: true as const })),
    prepareDelete: vi.fn(async () => ({ prepared: state.exists })),
    finalizeDelete: vi.fn(async () => {
      const deleted = state.exists;
      state = { ...state, exists: false, ready: false };
      return { deleted };
    }),
  };
  const persistence = new PostgresWorkspacePersistence({
    database: pg,
    files,
    storage: {
      pool: async () => ({ id: "owned-pool" }),
      inspectStorage: async () => ({ ...state }),
      prepareStorage: prepare,
      destroyStorage: destroy,
    },
  });
  return {
    pg,
    identity,
    persistence,
    prepare,
    destroy,
    files,
    setState(value: Partial<WorkspaceStorageSnapshot>) {
      state = { ...state, ...value };
    },
    async close() {
      await pg.end();
      await database.destroy();
    },
  };
}

it("initializes a Workspace independently and reconciles a lost reply without another create", async () => {
  const f = await fixture();
  try {
    const original = f.prepare.getMockImplementation()!;
    f.prepare.mockImplementationOnce(async (request) => {
      await original(request);
      throw new Error("lost storage response");
    });
    await expect(f.persistence.ensure(f.identity)).rejects.toThrow("lost storage response");
    const reference = await f.persistence.ensure(f.identity);
    expect(reference).toMatchObject({
      kind: "volume",
      volumeId: f.identity.volumeId,
      poolId: "owned-pool",
    });
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(
      (
        await f.pg.query(`select persistence_state from workspaces where id=$1::uuid`, [
          f.identity.workspaceId,
        ])
      ).rows[0].persistence_state,
    ).toBe("ready");
    f.setState({ exists: false, ready: false });
    await expect(f.persistence.ensure(f.identity)).rejects.toThrow("no empty replacement");
    expect(f.prepare).toHaveBeenCalledTimes(1);
  } finally {
    await f.close();
  }
});

it("keeps a missing initialization unconfirmed and blocks deletion without resending it", async () => {
  const f = await fixture();
  try {
    f.prepare.mockRejectedValueOnce(new Error("request outcome unknown"));
    await expect(f.persistence.ensure(f.identity)).rejects.toThrow("outcome unknown");
    await expect(f.persistence.ensure(f.identity)).rejects.toThrow("will not be resent");
    await f.pg.query(`update workspaces set deleted_at=clock_timestamp() where id=$1::uuid`, [
      f.identity.workspaceId,
    ]);
    await expect(f.persistence.prepareDelete(f.identity)).rejects.toThrow(
      "Resolve Workspace initialization",
    );
    expect(f.prepare).toHaveBeenCalledTimes(1);
    expect(f.destroy).not.toHaveBeenCalled();
    expect(f.files.prepareDelete).not.toHaveBeenCalled();
  } finally {
    await f.close();
  }
});

it("requires deletion intent and confirms duplicate cleanup without a Cube API", async () => {
  const f = await fixture();
  try {
    await f.persistence.ensure(f.identity);
    await expect(f.persistence.prepareDelete(f.identity)).rejects.toThrow("not admitted");
    await f.pg.query(`update workspaces set deleted_at=clock_timestamp() where id=$1::uuid`, [
      f.identity.workspaceId,
    ]);
    await expect(f.persistence.prepareDelete(f.identity)).resolves.toEqual({ prepared: true });
    await expect(f.persistence.finalizeDelete(f.identity)).resolves.toEqual({ deleted: true });
    await expect(f.persistence.prepareDelete(f.identity)).resolves.toEqual({ prepared: true });
    await expect(f.persistence.finalizeDelete(f.identity)).resolves.toEqual({ deleted: true });
  } finally {
    await f.close();
  }
});

it("does not force a persistent sandbox to manufacture an independent volume", () => {
  expect(
    requireRetainedWorkspace({
      kind: "retained-sandbox",
      computeRelease: "stop",
      shared: false,
      newSandbox: false,
    }),
  ).toBe("stop");
  expect(() =>
    requireRetainedWorkspace({
      kind: "retained-sandbox",
      computeRelease: "destroy",
      shared: false,
      newSandbox: false,
    }),
  ).toThrow("cannot retain");
  expect(() =>
    requireRetainedWorkspace({
      kind: "temporary",
      computeRelease: "destroy",
      shared: false,
      newSandbox: false,
    }),
  ).toThrow("cannot retain");
  expect(() =>
    requireRetainedWorkspace(
      { kind: "retained-sandbox", computeRelease: "pause", shared: false, newSandbox: false },
      true,
    ),
  ).toThrow("shared");
});

it("adopts an unused Workspace even when old quota reconciliation had already cleared pending", async () => {
  const f = await fixture();
  try {
    await f.pg.query(
      "update workspaces set persistence_state='adoption_pending',capacity_pending=false where id=$1::uuid",
      [f.identity.workspaceId],
    );
    const domain = (
      await f.pg.query("select sandbox_domain_id from workspaces where id=$1::uuid", [
        f.identity.workspaceId,
      ])
    ).rows[0].sandbox_domain_id;
    await f.persistence.adoptDomain(domain);
    expect(
      (
        await f.pg.query("select persistence_state from workspaces where id=$1::uuid", [
          f.identity.workspaceId,
        ])
      ).rows[0].persistence_state,
    ).toBe("uninitialized");
    expect(f.prepare).not.toHaveBeenCalled();
    f.setState({ known: true, exists: false });
    await f.pg.query(
      "update workspaces set persistence_state='adoption_pending' where id=$1::uuid",
      [f.identity.workspaceId],
    );
    await expect(f.persistence.adoptDomain(domain)).rejects.toThrow(
      "Previously initialized Workspace bytes are unavailable",
    );
  } finally {
    await f.close();
  }
});
