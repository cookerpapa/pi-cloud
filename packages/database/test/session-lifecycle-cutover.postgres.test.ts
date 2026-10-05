import { randomUUID } from "node:crypto";
import { Migrator } from "kysely/migration";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { createDatabase } from "../src/index.ts";
import { migrationProvider } from "../src/migrations/index.ts";
import { createPrivateTenant } from "../../control-plane/src/tenant-administration.ts";
import { insertHistoricalSession } from "./fixtures/historical-turn.ts";
import { ControlPlaneStore } from "../../control-plane/src/control-plane-store.ts";

const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
it.skipIf(!endpoint)(
  "refuses obsolete Session states atomically before installing the current lifecycle",
  async () => {
    const name = `session_states_${randomUUID().replaceAll("-", "")}`;
    const admin = createDatabase({ connectionString: endpoint!, maxConnections: 1 });
    await sql`create database ${sql.id(name)}`.execute(admin);
    const url = new URL(endpoint!);
    url.pathname = `/${name}`;
    const db = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
    try {
      const result = await new Migrator({
        db,
        provider: migrationProvider,
        allowUnorderedMigrations: true,
      }).migrateTo("156_permanent_conversation_deletion");
      if (result.error) throw result.error;
      const tenant = await createPrivateTenant(db, {
        // This fixture targets the historical schema before nullable quotas.
        quotas: { maximumProjects: 100, maximumSessions: 1000 },
        slug: "lifecycle",
        ownerDisplayName: "Fixture",
      });
      const store = new ControlPlaneStore({ database: db, ...tenant });
      const project = await store.createProject({ name: "retained", source: { kind: "empty" } });
      const session = await insertHistoricalSession(db, { ...tenant, ...project });
      const migrateLifecycle = async () => {
        const result = await new Migrator({
          db,
          provider: migrationProvider,
          allowUnorderedMigrations: true,
        }).migrateTo("157_atomic_session_lifecycle");
        if (result.error) throw result.error;
      };
      for (const retired of ["starting", "evicting", "recovering"]) {
        await sql`update sessions set state=${retired} where id=${session.sessionId}::uuid`.execute(
          db,
        );
        await expect(migrateLifecycle()).rejects.toThrow("Unsupported Session lifecycle rows");
        expect(
          await db
            .selectFrom("sessions")
            .select("state")
            .where("id", "=", session.sessionId)
            .executeTakeFirstOrThrow(),
        ).toEqual({ state: retired });
      }
      await db
        .updateTable("sessions")
        .set({ state: "cold" })
        .where("id", "=", session.sessionId)
        .execute();
      await migrateLifecycle();
      for (const retired of ["starting", "evicting", "recovering"]) {
        await expect(
          sql`update sessions set state=${retired} where id=${session.sessionId}::uuid`.execute(db),
        ).rejects.toMatchObject({ code: "23514" });
      }
      expect(await db.selectFrom("sessions").select("state").executeTakeFirstOrThrow()).toEqual({
        state: "cold",
      });
    } finally {
      await db.destroy();
      await sql`drop database ${sql.id(name)}`.execute(admin);
      await admin.destroy();
    }
  },
  60_000,
);
