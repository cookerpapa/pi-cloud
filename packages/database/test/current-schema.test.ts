import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { sql } from "kysely";
import { describe, expect, it, vi } from "vitest";
import { createDatabase, runMigrations } from "../src/index.ts";

vi.setConfig({ testTimeout: 30_000 });

describe("current PiCloud schema", () => {
  it("builds only the maintained authorities from an empty database", async () => {
    const pglite = await PGlite.create();
    const socket = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
    await socket.start();
    const database = createDatabase({
      connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
      maxConnections: 1,
    });
    try {
      await runMigrations(database, "up");
      await runMigrations(database, "up");

      const tables = await sql<{ table_name: string }>`
        select table_name
          from information_schema.tables
         where table_schema = 'public'
           and table_type = 'BASE TABLE'
      `.execute(database);
      const names = new Set(tables.rows.map((row) => row.table_name));
      for (const required of [
        "runs",
        "run_attempts",
        "session_leases",
        "session_kafka_heads",
        "pi_sessions",
        "pi_session_entries",
        "tool_broker_activations",
        "workspaces",
        "development_environments",
      ]) {
        expect(names.has(required), `missing current table ${required}`).toBe(true);
      }
      for (const retired of [
        "workspace_sources",
        "workspace_repository_sources",
        "github_app_installations",
        "github_repositories",
        "github_pull_request_deliveries",
        "github_webhook_deliveries",
        "approvals",
        "agent_nodes",
        "test_results",
      ]) {
        expect(names.has(retired), `retired table ${retired} survived`).toBe(false);
      }

      const columns = await sql<{ table_name: string; column_name: string }>`
        select table_name, column_name
          from information_schema.columns
         where table_schema = 'public'
           and table_name in ('workspaces', 'runs', 'tenant_runtime_policies')
      `.execute(database);
      const keys = new Set(columns.rows.map((row) => `${row.table_name}.${row.column_name}`));
      expect(keys.has("workspaces.seed_kind")).toBe(true);
      expect(keys.has("workspaces.object_snapshot_key")).toBe(false);
      expect(keys.has("runs.source_set_snapshot")).toBe(false);
      expect(keys.has("tenant_runtime_policies.maximum_concurrent_turns")).toBe(false);
      expect(keys.has("tenant_runtime_policies.maximum_active_sandboxes")).toBe(false);

      const activationIndexes = await sql<{ indexname: string; indexdef: string }>`
        select indexname, indexdef
          from pg_indexes
         where schemaname = 'public'
           and indexname in ('tool_broker_workspace_live_unique', 'tool_broker_workspace_live_idx')
      `.execute(database);
      expect(activationIndexes.rows).toEqual([
        expect.objectContaining({
          indexname: "tool_broker_workspace_live_unique",
          indexdef: expect.stringContaining("UNIQUE"),
        }),
      ]);

      const applied = await sql<{ name: string }>`
        select name from kysely_migration order by name
      `.execute(database);
      expect(applied.rows.at(-1)?.name).toBe("102_workspace_tool_runtime_slot");

      const legacyFunctions = await sql<{ proname: string }>`
        select proname
          from pg_proc
         where proname in (
           'agent_dock_reject_orchestration_acceptance_mutation',
           'agent_dock_reject_review_bundle_mutation'
         )
      `.execute(database);
      expect(legacyFunctions.rows).toEqual([]);
    } finally {
      await database.destroy();
      await socket.stop();
      await pglite.close();
    }
  });
});
