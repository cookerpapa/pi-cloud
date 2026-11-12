import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { parseCreateProjectRequest } from "@pi-cloud/protocol";

it("records explicit Workspace placement and atomically rejects stale or unavailable backend selection", async () => {
  const db = createDatabase({
    connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!,
    maxConnections: 2,
  });
  try {
    await runMigrations(db, "up");
    const tenant = await createPrivateTenant(db, {
      slug: randomUUID(),
      ownerDisplayName: "Backend selection",
    });
    const store = new ControlPlaneStore({ database: db, ...tenant });
    const id = randomUUID();
    await db
      .insertInto("sandbox_domains")
      .values({
        id,
        display_name: "Owned BoxLite",
        state: "active",
        sandbox_control_base_url: "http://owned.invalid:4300",
        workspace_storage_key: "owned",
        backend_revision: 7,
        backend_catalog: {
          templates: [
            { id: "linux", name: "Linux", profiles: ["starter", "standard", "performance"] },
          ],
        },
      })
      .execute();
    const selection = { id, templateId: "linux", revision: 7 };
    const input = parseCreateProjectRequest({
      name: "Placed Workspace",
      source: { kind: "empty" },
      backend: selection,
    });
    await expect(
      store.createProject({ ...input, backend: { ...selection, revision: 6 } }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      await db
        .selectFrom("projects")
        .select("id")
        .where("tenant_id", "=", tenant.tenantId)
        .execute(),
    ).toHaveLength(0);
    const created = await store.createProject(input);
    expect(
      await db
        .selectFrom("workspaces")
        .select(["sandbox_domain_id", "backend_template_id"])
        .where("id", "=", created.workspaceId)
        .executeTakeFirst(),
    ).toEqual({ sandbox_domain_id: id, backend_template_id: "linux" });
    await db
      .updateTable("sandbox_domains")
      .set({ state: "draining" })
      .where("id", "=", id)
      .execute();
    await expect(store.createProject({ ...input, name: "Refused Workspace" })).rejects.toThrow(
      "No active Sandbox Domain",
    );
    expect(
      await db
        .selectFrom("projects")
        .select("id")
        .where("tenant_id", "=", tenant.tenantId)
        .execute(),
    ).toHaveLength(1);
  } finally {
    await db.destroy();
  }
});
