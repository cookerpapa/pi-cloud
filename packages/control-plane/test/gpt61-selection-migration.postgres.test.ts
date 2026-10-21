import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { sql } from "kysely";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { up } from "../../database/src/migrations/195_gpt61_sol_selection.ts";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { appendNativeFixture } from "./fixtures/durable-native.ts";

it.skipIf(!process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL)(
  "upgrades only future Sol selections after draining, retaining history and restricted effort settings",
  async () => {
    const admin = createDatabase({
      connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!,
      maxConnections: 1,
    });
    const name = `pi_gpt61_${randomUUID().replaceAll("-", "")}`;
    await sql`create database ${sql.id(name)}`.execute(admin);
    const url = new URL(process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!);
    url.pathname = `/${name}`;
    const db = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
    try {
      await runMigrations(db, "up");
      const luna = await createPrivateTenant(db, {
        slug: randomUUID(),
        ownerDisplayName: "Unchanged Luna",
        initialModel: { provider: "openai-codex", modelId: "gpt-6-luna" },
      });
      const lunaProfile = await db
        .selectFrom("model_profiles")
        .selectAll()
        .where("id", "=", luna.defaultModelProfileId)
        .executeTakeFirstOrThrow();
      for (const effort of ["off", "minimal", "high"] as const) {
        const tenant = await createPrivateTenant(db, {
          slug: randomUUID(),
          ownerDisplayName: "Sol migration",
          initialModel: { provider: "openai-codex", modelId: "gpt-6.1-sol" },
        });
        const store = new ControlPlaneStore({ database: db, ...tenant });
        const project = await store.createProject({ name: "model", source: { kind: "empty" } });
        const session = await store.createSession(
          project.projectId,
          project.workspaceId,
          "Sol",
          "elastic",
        );
        const run = await store.acceptTurn(session.sessionId, randomUUID(), {
          prompt: "historical input",
        });
        await db
          .updateTable("model_profiles")
          .set({
            model_id: "gpt-6-sol",
            default_thinking_level: effort,
            allowed_thinking_levels: [effort, "medium"],
          })
          .where("id", "=", tenant.defaultModelProfileId)
          .execute();
        await db
          .updateTable("sessions")
          .set({ desired_thinking_level: effort, desired_service_tier: "fast" })
          .where("id", "=", session.sessionId)
          .execute();
        await db
          .updateTable("credential_bindings")
          .set({ secret_ref: "provider-gateway://openai-codex/gpt-6-sol" })
          .where("id", "=", tenant.credentialBindingId)
          .execute();
        await db
          .updateTable("runs")
          .set({ model_id: "gpt-6-sol", thinking_level: effort })
          .where("id", "=", run.runId)
          .execute();
        const profile = () =>
          db
            .selectFrom("model_profiles")
            .selectAll()
            .where("id", "=", tenant.defaultModelProfileId)
            .executeTakeFirstOrThrow();
        const beforeRefusal = await profile();
        await expect(up(db as unknown as Parameters<typeof up>[0])).rejects.toThrow(
          "Drain GPT-6 Sol",
        );
        expect(await profile()).toEqual(beforeRefusal);
        await db
          .updateTable("runs")
          .set({ state: "completed", settled_at: new Date() })
          .where("id", "=", run.runId)
          .execute();
        await appendNativeFixture(db, { tenantId: tenant.tenantId, sessionId: session.sessionId }, [
          { kind: "pi-cloud.accepted-model", data: { modelId: "gpt-6-sol", effort } },
        ]);
        const history = async () =>
          (
            await sql`select * from pi_durable_log
            where tenant_id=${tenant.tenantId}::uuid order by seq, ordinal`.execute(db)
          ).rows;
        const runRow = () =>
          db.selectFrom("runs").selectAll().where("id", "=", run.runId).executeTakeFirstOrThrow();
        const beforeRun = await runRow(),
          beforeHistory = await history();
        const credentials = await db
          .selectFrom("tenant_api_credentials")
          .selectAll()
          .where("tenant_id", "=", tenant.tenantId)
          .execute();
        await db.transaction().execute((tx) => up(tx as unknown as Parameters<typeof up>[0]));
        const expected = effort === "high" ? "high" : "medium";
        expect(await profile()).toMatchObject({
          model_id: "gpt-6.1-sol",
          default_thinking_level: expected,
          allowed_thinking_levels: effort === "high" ? ["high", "medium"] : ["medium"],
        });
        expect(
          await db
            .selectFrom("sessions")
            .select(["desired_thinking_level", "desired_service_tier"])
            .where("id", "=", session.sessionId)
            .executeTakeFirstOrThrow(),
        ).toEqual({
          desired_thinking_level: expected,
          desired_service_tier: "fast",
        });
        expect(
          await db
            .selectFrom("credential_bindings")
            .select(["secret_ref", "version"])
            .where("id", "=", tenant.credentialBindingId)
            .executeTakeFirstOrThrow(),
        ).toMatchObject({
          secret_ref: "provider-gateway://openai-codex/gpt-6.1-sol",
          version: "1",
        });
        expect(await runRow()).toEqual(beforeRun);
        expect(await history()).toEqual(beforeHistory);
        expect(
          await db
            .selectFrom("tenant_api_credentials")
            .selectAll()
            .where("tenant_id", "=", tenant.tenantId)
            .execute(),
        ).toEqual(credentials);
        const after = await profile();
        await up(db as unknown as Parameters<typeof up>[0]);
        expect(await profile()).toEqual(after);
      }
      expect(
        await db
          .selectFrom("model_profiles")
          .selectAll()
          .where("id", "=", luna.defaultModelProfileId)
          .executeTakeFirstOrThrow(),
      ).toEqual(lunaProfile);
    } finally {
      await db.destroy();
      await sql`drop database ${sql.id(name)}`.execute(admin);
      await admin.destroy();
    }
  },
  60000,
);
