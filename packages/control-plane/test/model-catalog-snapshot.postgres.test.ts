import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { sql } from "kysely";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { fixtureModelCatalog } from "../../../scripts/lib/test-model-catalog.mjs";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { createTestWorker } from "./admit-test-execution.ts";

it.skipIf(!process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL)(
  "freezes Run capabilities before catalog changes and dispatches that exact snapshot",
  async () => {
    const admin = createDatabase({
      connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!,
      maxConnections: 1,
    });
    const name = `pi_catalog_${randomUUID().replaceAll("-", "")}`;
    await sql`create database ${sql.id(name)}`.execute(admin);
    const url = new URL(process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!);
    url.pathname = `/${name}`;
    const db = createDatabase({ connectionString: url.toString(), maxConnections: 4 });
    const dir = mkdtempSync(join(tmpdir(), "pi-run-catalog-")),
      path = join(dir, "catalog.json");
    const config = structuredClone(fixtureModelCatalog);
    const model = config.models.find((m) => m.modelId === "gpt-6-luna")!;
    model.modelId = "future-model";
    if (!model.thinkingLevels.includes("ultra")) model.thinkingLevels.push("ultra");
    writeFileSync(path, JSON.stringify(config));
    vi.stubEnv("PI_CLOUD_MODEL_CATALOG_FILE", path);
    try {
      await runMigrations(db, "up");
      const tenant = await createPrivateTenant(db, {
        slug: randomUUID(),
        ownerDisplayName: "catalog",
        initialModel: { provider: "openai-codex", modelId: "future-model" },
      });
      const store = new ControlPlaneStore({ database: db, ...tenant });
      const project = await store.createProject({ name: "catalog", source: { kind: "empty" } });
      const session = await store.createSession(
        project.projectId,
        project.workspaceId,
        "model",
        "elastic",
      );
      await store.updateSessionModel(session.sessionId, {
        provider: "openai-codex",
        modelId: "future-model",
        thinkingLevel: "ultra",
        fastMode: false,
      });
      const first = await store.acceptTurn(session.sessionId, randomUUID(), {
        prompt: "old capability",
      });
      const before = await db
        .selectFrom("runs")
        .selectAll()
        .where("id", "=", first.runId)
        .executeTakeFirstOrThrow();
      expect(before.model_runtime_snapshot).toMatchObject({ maxTokens: 65536 });
      expect(before.thinking_level).toBe("ultra");
      model.maxTokens = 32768;
      writeFileSync(path, JSON.stringify(config));
      await delay(1100);
      const worker = await createTestWorker(db);
      let received: unknown;
      let selected: string | undefined;
      const executor = worker.executor({
        execute: async (request, lifecycle) => {
          received = request.model.runtime;
          selected = request.model.thinkingLevel;
          lifecycle.executionExited();
          return { stopReason: "stop" };
        },
      });
      await executor.dispatchRun(first.runId);
      expect(received).toEqual(before.model_runtime_snapshot);
      expect(selected).toBe("ultra");
      const secondSession = await store.createSession(
        project.projectId,
        project.workspaceId,
        "new model",
        "elastic",
      );
      const second = await store.acceptTurn(secondSession.sessionId, randomUUID(), {
        prompt: "new capability",
      });
      const after = await db
        .selectFrom("runs")
        .select("model_runtime_snapshot")
        .where("id", "=", second.runId)
        .executeTakeFirstOrThrow();
      expect(after.model_runtime_snapshot).toMatchObject({ maxTokens: 32768 });
      expect(after.model_runtime_snapshot).not.toEqual(before.model_runtime_snapshot);
      model.visible = false;
      writeFileSync(path, JSON.stringify(config));
      await delay(1100);
      expect((await store.getSessionModel(session.sessionId)).modelId).toBe("future-model");
      await expect(
        store.acceptTurn(session.sessionId, randomUUID(), { prompt: "withdrawn" }),
      ).rejects.toThrow("unavailable");
      expect(
        (
          await db
            .selectFrom("runs")
            .select("model_runtime_snapshot")
            .where("id", "=", first.runId)
            .executeTakeFirstOrThrow()
        ).model_runtime_snapshot,
      ).toEqual(before.model_runtime_snapshot);
    } finally {
      vi.unstubAllEnvs();
      rmSync(dir, { recursive: true, force: true });
      await db.destroy();
      await sql`drop database ${sql.id(name)}`.execute(admin);
      await admin.destroy();
    }
  },
  60000,
);
