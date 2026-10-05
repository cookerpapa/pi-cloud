import { randomUUID } from "node:crypto";
import { it, expect } from "vitest";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { appendNativeFixture } from "./fixtures/durable-native.ts";
import { sql } from "kysely";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { up } from "../../database/src/migrations/150_gpt6_model_selection.ts";

it.skipIf(!process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL)(
  "migrates future GPT selections while preserving issued snapshots and native history",
  async () => {
    const admin = createDatabase({
      connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!,
      maxConnections: 1,
    });
    const name = `pi_gpt6_${randomUUID().replaceAll("-", "")}`;
    await sql`create database ${sql.id(name)}`.execute(admin);
    const url = new URL(process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!);
    url.pathname = `/${name}`;
    const db = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
    try {
      await runMigrations(db, "up");
      for (const [oldModel, newModel] of [
        ["gpt-5.6-luna", "gpt-6-luna"],
        ["gpt-5.6-sol", "gpt-6-sol"],
        ["gpt-5.6-terra", "gpt-6-sol"],
      ] as const) {
        const tenant = await createPrivateTenant(db, {
          slug: randomUUID(),
          ownerDisplayName: "model migration",
          initialModel: { provider: "openai-codex", modelId: newModel },
        });
        const control = new ControlPlaneStore({ database: db, ...tenant });
        const project = await control.createProject({ name: "models", source: { kind: "empty" } });
        const session = await control.createSession(
          project.projectId,
          project.workspaceId,
          "model migration",
          "elastic",
        );
        const run = await control.acceptTurn(session.sessionId, randomUUID(), {
          prompt: "accepted before model migration",
        });
        await sql`update model_profiles set model_id=${oldModel} where tenant_id=${tenant.tenantId}::uuid`.execute(
          db,
        );
        await sql`update turns set model_id=${oldModel} where id=${run.turnId}::uuid`.execute(db);
        await appendNativeFixture(db, { tenantId: tenant.tenantId, sessionId: session.sessionId }, [
          {
            kind: "pi-cloud.accepted-model",
            data: { provider: "openai-codex", modelId: oldModel },
          },
        ]);
        const historyRows = async () =>
          (
            await sql`select * from pi_durable_log where tenant_id=${tenant.tenantId}::uuid and session_id=${session.sessionId} order by seq,ordinal`.execute(
              db,
            )
          ).rows;
        const beforeRun = await db
          .selectFrom("runs")
          .selectAll()
          .where("id", "=", run.runId)
          .executeTakeFirstOrThrow();
        const beforeTurn = await db
          .selectFrom("turns")
          .selectAll()
          .where("id", "=", run.turnId)
          .executeTakeFirstOrThrow();
        const history = await historyRows();
        await up(db as unknown as Parameters<typeof up>[0]);
        expect(
          (
            await db
              .selectFrom("model_profiles")
              .select("model_id")
              .where("tenant_id", "=", tenant.tenantId)
              .executeTakeFirstOrThrow()
          ).model_id,
        ).toBe(newModel);
        expect(
          await db
            .selectFrom("runs")
            .selectAll()
            .where("id", "=", run.runId)
            .executeTakeFirstOrThrow(),
        ).toEqual(beforeRun);
        expect(
          await db
            .selectFrom("turns")
            .selectAll()
            .where("id", "=", run.turnId)
            .executeTakeFirstOrThrow(),
        ).toEqual(beforeTurn);
        expect(await historyRows()).toEqual(history);
      }
    } finally {
      await db.destroy();
      await sql`drop database ${sql.id(name)}`.execute(admin);
      await admin.destroy();
    }
  },
  60000,
);
