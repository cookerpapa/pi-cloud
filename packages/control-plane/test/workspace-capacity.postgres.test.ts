import { randomUUID } from "node:crypto";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { sql, type Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ControlPlaneStore, createPrivateTenant } from "../src/index.ts";
import { WorkspaceCapacityService } from "../src/workspace-capacity-service.ts";
import { WorkspaceCapacityReconciler } from "../../sandbox-control/src/workspace-capacity-reconciler.ts";
import type { WorkspaceVolumeGateway } from "../../sandbox-control/src/workspace-volume-gateway-contract.ts";

const connectionString = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
describe.skipIf(!connectionString)("Workspace capacity intent", () => {
  const name = `workspace_capacity_${randomUUID().replaceAll("-", "")}`;
  let admin: Kysely<Database>, database: Kysely<Database>, store: ControlPlaneStore;
  let scope: Awaited<ReturnType<typeof createPrivateTenant>>;
  let service: WorkspaceCapacityService;
  beforeAll(async () => {
    admin = createDatabase({ connectionString: connectionString!, maxConnections: 1 });
    await sql`create database ${sql.id(name)}`.execute(admin);
    const url = new URL(connectionString!);
    url.pathname = `/${name}`;
    database = createDatabase({ connectionString: url.toString(), maxConnections: 4 });
    await runMigrations(database, "up");
    scope = await createPrivateTenant(database, {
      slug: name.replaceAll("_", "-"),
      ownerDisplayName: "Capacity fixture",
    });
    store = new ControlPlaneStore({ database, ...scope });
    service = new WorkspaceCapacityService(database);
  }, 60_000);
  afterAll(async () => {
    await database?.destroy();
    if (admin) {
      await sql`drop database if exists ${sql.id(name)}`.execute(admin);
      await admin.destroy();
    }
  });
  const workspace = () =>
    store.createProject({ name: `Capacity ${randomUUID()}`, source: { kind: "empty" } });

  it("keeps concurrent growth monotonic and rejects stale delivery acknowledgements", async () => {
    const { workspaceId } = await workspace();
    expect(await service.read(scope.tenantId, workspaceId)).toMatchObject({
      capacityBytes: 32 * 1024 ** 3,
      revision: 1,
      pending: false,
    });
    await Promise.all([
      service.grow(scope.tenantId, workspaceId, 64),
      service.grow(scope.tenantId, workspaceId, 128),
    ]);
    const latest = (await service.read(scope.tenantId, workspaceId))!;
    expect(latest.capacityBytes).toBe(128 * 1024 ** 3);
    expect(latest.pending).toBe(true);
    expect(await service.grow(scope.tenantId, workspaceId, 64)).toEqual(latest);
    const staleAck = await database
      .updateTable("workspaces")
      .set({ capacity_pending: false })
      .where("id", "=", workspaceId)
      .where("capacity_revision", "=", "1")
      .executeTakeFirst();
    expect(staleAck.numUpdatedRows).toBe(0n);
    expect(await service.read(randomUUID(), workspaceId)).toBeUndefined();
    expect(await service.grow(randomUUID(), workspaceId, 256)).toBeUndefined();
    await database
      .updateTable("workspaces")
      .set({ deleted_at: new Date(), capacity_pending: false })
      .where("id", "=", workspaceId)
      .execute();
    expect(await service.grow(scope.tenantId, workspaceId, 256)).toBeUndefined();
  });

  it("retries durable intent without starving later Workspaces and aborts pending delivery on shutdown", async () => {
    const ids: string[] = [];
    for (let i = 0; i < 40; i++) ids.push((await workspace()).workspaceId);
    ids.sort();
    await database
      .updateTable("workspaces")
      .set({ capacity_pending: true })
      .where("id", "in", ids)
      .execute();
    const { sandbox_domain_id: domain } = await database
      .selectFrom("workspaces")
      .select("sandbox_domain_id")
      .where("id", "=", ids[0]!)
      .executeTakeFirstOrThrow();
    const seen: string[] = [];
    const gateway = {
      reconcileQuota: async (input: { workspaceId: string }) => {
        seen.push(input.workspaceId);
        if (ids.indexOf(input.workspaceId) < 32) throw new Error("Storage temporarily unavailable");
        await database
          .updateTable("workspaces")
          .set({ capacity_pending: false })
          .where("id", "=", input.workspaceId)
          .execute();
        return { applied: true };
      },
    } as unknown as WorkspaceVolumeGateway;
    const reconciler = new WorkspaceCapacityReconciler(database, domain, gateway);
    await expect(reconciler.runOnce()).rejects.toThrow("remain pending");
    await reconciler.runOnce();
    expect(new Set(seen)).toEqual(new Set(ids));
    expect(
      await database
        .selectFrom("workspaces")
        .select("id")
        .where("capacity_pending", "=", true)
        .execute(),
    ).toHaveLength(32);
    await reconciler.close();
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    let aborted = false;
    const blockedGateway = {
      reconcileQuota: async (_: unknown, signal: AbortSignal) => {
        started();
        return new Promise((_, reject) =>
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(signal.reason);
            },
            { once: true },
          ),
        );
      },
    } as unknown as WorkspaceVolumeGateway;
    const closing = new WorkspaceCapacityReconciler(database, domain, blockedGateway);
    closing.start(() => {});
    await startedPromise;
    await closing.close();
    expect(aborted).toBe(true);
  });
});
