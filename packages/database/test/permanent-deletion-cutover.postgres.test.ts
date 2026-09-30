import { randomUUID } from "node:crypto";
import { Migrator } from "kysely/migration";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { createDatabase, runMigrations } from "../src/index.ts";
import { migrationProvider } from "../src/migrations/index.ts";
import { createPrivateTenant } from "../../control-plane/src/tenant-administration.ts";
import { ControlPlaneStore } from "../../control-plane/src/control-plane-store.ts";
import { insertHistoricalPrompt, insertHistoricalSession } from "./fixtures/historical-turn.ts";

const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
it.skipIf(!endpoint)(
  "cuts over hidden history only after quiescence, retains visible Sessions and removes archive schema",
  async () => {
    const name = `delete_cutover_${randomUUID().replaceAll("-", "")}`;
    const admin = createDatabase({ connectionString: endpoint!, maxConnections: 1 });
    await sql`create database ${sql.id(name)}`.execute(admin);
    const url = new URL(endpoint!);
    url.pathname = `/${name}`;
    const db = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
    try {
      const migrated = await new Migrator({
        db,
        provider: migrationProvider,
        allowUnorderedMigrations: true,
      }).migrateTo("155_remove_unused_subagent_result_pointer");
      if (migrated.error) throw migrated.error;
      const tenant = await createPrivateTenant(db, {
        slug: "delete-cutover",
        ownerDisplayName: "Cutover",
      });
      const store = new ControlPlaneStore({ database: db, ...tenant });
      const project = await store.createProject({
        name: "retained files",
        source: { kind: "empty" },
      });
      const hidden = await insertHistoricalSession(db, { ...tenant, ...project });
      const visible = await insertHistoricalSession(db, { ...tenant, ...project });
      const accepted = await insertHistoricalPrompt(db, {
        ...tenant,
        ...project,
        modelProfileId: tenant.defaultModelProfileId,
        environmentVersionId: project.environment.environmentVersionId,
        sessionId: hidden.sessionId,
        prompt: "erase after settlement",
      });
      await sql`update sessions set archived_at=now() where id=${hidden.sessionId}::uuid`.execute(
        db,
      );
      await expect(runMigrations(db, "up")).rejects.toThrow("Hidden conversations must quiesce");
      expect(await db.selectFrom("sessions").select("id").execute()).toHaveLength(2);
      await db
        .updateTable("runs")
        .set({ state: "cancelled", settled_at: new Date() })
        .where("id", "=", accepted.runId)
        .execute();
      await db
        .updateTable("turns")
        .set({ state: "cancelled", settled_at: new Date() })
        .where("id", "=", accepted.turnId)
        .execute();
      await runMigrations(db, "up");
      expect(await db.selectFrom("sessions").select(["id", "pruned_at"]).execute()).toEqual([
        { id: visible.sessionId, pruned_at: null },
      ]);
      expect(await db.selectFrom("pi_sessions").select("id").execute()).toEqual([
        { id: visible.sessionId },
      ]);
      expect(await db.selectFrom("runs").select("id").execute()).toEqual([]);
      expect(
        await db
          .selectFrom("workspaces")
          .select("deleted_at")
          .where("id", "=", project.workspaceId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ deleted_at: null });
      expect(
        (
          await sql<{
            name: string | null;
          }>`select to_regclass('workspace_operations')::text as name`.execute(db)
        ).rows[0]?.name,
      ).toBeNull();
    } finally {
      await db.destroy();
      await sql`drop database ${sql.id(name)}`.execute(admin);
      await admin.destroy();
    }
  },
  60_000,
);
