import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { Migrator } from "kysely/migration";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { migrationProvider } from "../../database/src/migrations/index.ts";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { ControlPlaneStore } from "../src/control-plane-store.ts";

const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
describe.skipIf(!endpoint)("unlimited product quotas", () => {
  let admin: Pool;
  const databases: string[] = [];
  beforeAll(() => {
    admin = new Pool({ connectionString: endpoint!, max: 1 });
  });
  afterAll(async () => {
    for (const name of databases) await admin.query(`drop database "${name}"`);
    await admin.end();
  });
  async function database() {
    const name = `unlimited_${randomUUID().replaceAll("-", "")}`;
    databases.push(name);
    await admin.query(`create database "${name}"`);
    const url = new URL(endpoint!);
    url.pathname = `/${name}`;
    return createDatabase({ connectionString: url.toString(), maxConnections: 2 });
  }
  it("removes existing quotas while retaining existing projects and conversations", async () => {
    const db = await database();
    try {
      const migrator = new Migrator({ db, provider: migrationProvider });
      const old = await migrator.migrateTo("165_coalesced_control_changes");
      if (old.error) throw old.error;
      const tenant = await createPrivateTenant(db, {
        slug: randomUUID(),
        ownerDisplayName: "quota migration",
        quotas: { maximumProjects: 1, maximumSessions: 1 },
      });
      await db
        .insertInto("sandbox_domains")
        .values({
          id: "sandbox-domain-0001",
          display_name: "fixture",
          state: "active",
          sandbox_control_base_url: "http://fixture:4300",
          workspace_storage_key: "fixture",
        })
        .onConflict((c) => c.column("id").doNothing())
        .execute();
      const store = new ControlPlaneStore({ database: db, ...tenant });
      const first = await store.createProject({ name: "first", source: { kind: "empty" } });
      await store.createSession(first.projectId, first.workspaceId, "first", "elastic");
      await expect(
        store.createProject({ name: "blocked", source: { kind: "empty" } }),
      ).rejects.toMatchObject({ code: "tenant_quota_exceeded" });
      await runMigrations(db, "up");
      expect(
        await db
          .selectFrom("tenant_runtime_policies")
          .select(["maximum_projects", "maximum_sessions"])
          .where("tenant_id", "=", tenant.tenantId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ maximum_projects: null, maximum_sessions: null });
      expect(
        (
          await db
            .selectFrom("sandbox_domains")
            .select("maximum_active_sandboxes")
            .executeTakeFirstOrThrow()
        ).maximum_active_sandboxes,
      ).toBeNull();
      const second = await store.createProject({ name: "second", source: { kind: "empty" } });
      const session = await store.createSession(
        second.projectId,
        second.workspaceId,
        "second",
        "elastic",
      );
      expect(session.projectId).toBe(second.projectId);
      expect(
        (
          await db
            .selectFrom("projects")
            .select("id")
            .where("id", "=", first.projectId)
            .executeTakeFirst()
        )?.id,
      ).toBe(first.projectId);
    } finally {
      await db.destroy();
    }
  }, 60000);
  it("defaults new tenants to no project or Session quota and exceeds the old defaults", async () => {
    const db = await database();
    try {
      await runMigrations(db, "up");
      const tenant = await createPrivateTenant(db, {
        slug: randomUUID(),
        ownerDisplayName: "unlimited",
      });
      expect(tenant.quotas).toEqual({ maximumProjects: null, maximumSessions: null });
      await db
        .insertInto("sandbox_domains")
        .values({
          id: "sandbox-domain-0001",
          display_name: "fixture",
          state: "active",
          sandbox_control_base_url: "http://fixture:4300",
          workspace_storage_key: "fixture",
        })
        .onConflict((c) => c.column("id").doNothing())
        .execute();
      const store = new ControlPlaneStore({ database: db, ...tenant });
      let project;
      for (let n = 0; n < 101; n++)
        project = await store.createProject({ name: `project ${n}`, source: { kind: "empty" } });
      for (let n = 0; n < 1001; n++)
        await store.createSession(
          project!.projectId,
          project!.workspaceId,
          `session ${n}`,
          "elastic",
        );
      expect(
        Number(
          (
            await db
              .selectFrom("projects")
              .select((eb) => eb.fn.countAll<string>().as("n"))
              .executeTakeFirstOrThrow()
          ).n,
        ),
      ).toBe(101);
      expect(
        Number(
          (
            await db
              .selectFrom("sessions")
              .select((eb) => eb.fn.countAll<string>().as("n"))
              .executeTakeFirstOrThrow()
          ).n,
        ),
      ).toBe(1001);
    } finally {
      await db.destroy();
    }
  }, 120000);
});
