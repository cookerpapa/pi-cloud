import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { createPrivateTenant } from "../../control-plane/src/tenant-administration.ts";
import { ControlPlaneStore } from "../../control-plane/src/control-plane-store.ts";
import { WorkspaceVolumeDeletionReaper } from "../src/workspace-volume-deletion-reaper.ts";
import {
  workspaceVolumeId,
  type WorkspaceVolumeGateway,
} from "../src/workspace-volume-gateway-contract.ts";

it.skipIf(!process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL)(
  "a failed full batch cannot starve a later healthy Workspace even after retries become due",
  async () => {
    const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!;
    const admin = createDatabase({ connectionString: endpoint, maxConnections: 1 });
    const name = `fair_cleanup_${randomUUID().replaceAll("-", "")}`;
    await sql`create database ${sql.id(name)}`.execute(admin);
    const url = new URL(endpoint);
    url.pathname = "/" + name;
    const db = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
    let reaper: WorkspaceVolumeDeletionReaper | undefined;
    try {
      await runMigrations(db, "up");
      const tenant = await createPrivateTenant(db, {
        slug: name.replaceAll("_", "-"),
        ownerDisplayName: "Cleanup fixture",
      });
      const store = new ControlPlaneStore({ database: db, ...tenant });
      const workspaces = [];
      for (let i = 0; i < 17; i++) {
        const project = await store.createProject({
          name: `Cleanup ${i}`,
          source: { kind: "empty" },
        });
        workspaces.push(project.workspaceId);
        await db
          .updateTable("workspaces")
          .set({ deleted_at: new Date(1000 + i) })
          .where("id", "=", project.workspaceId)
          .execute();
      }
      const healthy = workspaces.at(-1)!;
      const healthyVolume = workspaceVolumeId({ tenantId: tenant.tenantId, workspaceId: healthy });
      const domain = await db
        .selectFrom("workspaces")
        .select("sandbox_domain_id")
        .where("id", "=", healthy)
        .executeTakeFirstOrThrow();
      const attempts: string[] = [];
      let failed = true;
      reaper = new WorkspaceVolumeDeletionReaper({
        database: db,
        sandboxDomainId: domain.sandbox_domain_id,
        gateway: {
          async prepareDelete() {},
          async finalizeDelete() {},
        } as unknown as WorkspaceVolumeGateway,
        async deleteVolumeMetadata(id) {
          attempts.push(id);
          if (failed && id !== healthyVolume) throw new Error("stale refcount");
        },
        onError() {},
      });
      expect(await reaper.runOnce()).toBe(0);
      expect(attempts).toHaveLength(16);
      await delay(1100); // Both failed items and the untouched item are now due.
      expect(await reaper.runOnce()).toBe(1);
      expect(attempts).toContain(healthyVolume);
      const row = await db
        .selectFrom("workspaces")
        .select("storage_purged_at")
        .where("id", "=", healthy)
        .executeTakeFirstOrThrow();
      expect(row.storage_purged_at).not.toBeNull();
      failed = false;
      await db
        .updateTable("workspaces")
        .set({ storage_purge_available_at: new Date(0) })
        .where("tenant_id", "=", tenant.tenantId)
        .execute();
      expect(await reaper.runOnce()).toBe(16);
    } finally {
      await reaper?.close();
      await db.destroy();
      try {
        await sql`drop database ${sql.id(name)}`.execute(admin);
      } finally {
        await admin.destroy();
      }
    }
  },
  30000,
);
