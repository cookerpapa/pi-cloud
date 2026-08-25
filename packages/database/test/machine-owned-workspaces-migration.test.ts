import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { downMachineOwnedWorkspaces, upMachineOwnedWorkspaces } from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

describe("machine-owned Workspace migration", () => {
  it("separates development machine Volumes from elastic Workspaces", async () => {
    const postgres = await PGlite.create();
    try {
      await postgres.exec(`
        create table sessions (
          id uuid primary key,
          sandbox_retention_policy text not null default 'ephemeral',
          constraint sessions_sandbox_retention_policy_valid
            check (sandbox_retention_policy in ('ephemeral', 'persistent'))
        );
        create table workspaces (
          id uuid primary key,
          tenant_id uuid not null,
          workspace_kind text not null default 'user',
          parent_workspace_id uuid,
          constraint workspaces_tenant_id_id_unique unique (tenant_id, id),
          constraint workspaces_kind_valid check (workspace_kind in ('user', 'subagent_isolated')),
          constraint workspaces_parent_shape check (
            (workspace_kind = 'user' and parent_workspace_id is null)
            or (workspace_kind = 'subagent_isolated' and parent_workspace_id is not null and parent_workspace_id <> id)
          )
        );
        create table development_environments (
          id uuid primary key,
          tenant_id uuid not null,
          workspace_id uuid not null
        );
        create table development_environment_operations (
          id uuid primary key,
          action text not null,
          constraint development_environment_operations_action_valid
            check (action in ('start', 'pause', 'resume', 'release'))
        );
        insert into workspaces (id, tenant_id) values
          ('10000000-0000-4000-8000-000000000001', '20000000-0000-4000-8000-000000000001'),
          ('10000000-0000-4000-8000-000000000002', '20000000-0000-4000-8000-000000000001');
        insert into development_environments values (
          '30000000-0000-4000-8000-000000000001',
          '20000000-0000-4000-8000-000000000001',
          '10000000-0000-4000-8000-000000000002'
        );
        insert into sessions (id, sandbox_retention_policy) values
          ('50000000-0000-4000-8000-000000000001', 'ephemeral'),
          ('50000000-0000-4000-8000-000000000002', 'persistent');
      `);

      await applyCompiledQueries(postgres, await compileMigration(upMachineOwnedWorkspaces));
      const upgraded = await postgres.query<{ id: string; workspace_kind: string }>(
        "select id, workspace_kind from workspaces order by id",
      );
      expect(upgraded.rows).toEqual([
        { id: "10000000-0000-4000-8000-000000000001", workspace_kind: "user" },
        {
          id: "10000000-0000-4000-8000-000000000002",
          workspace_kind: "development_environment",
        },
      ]);
      const modes = await postgres.query<{ execution_mode: string }>(
        "select execution_mode from sessions order by id",
      );
      expect(modes.rows).toEqual([
        { execution_mode: "elastic" },
        { execution_mode: "development_environment" },
      ]);
      await expect(
        postgres.query("insert into development_environment_operations values ($1, 'start')", [
          "40000000-0000-4000-8000-000000000001",
        ]),
      ).rejects.toThrow();
      await expect(
        postgres.query(
          "insert into workspaces (id, tenant_id, workspace_kind, parent_workspace_id) values ($1, $2, 'development_environment', $3)",
          [
            "10000000-0000-4000-8000-000000000003",
            "20000000-0000-4000-8000-000000000001",
            "10000000-0000-4000-8000-000000000001",
          ],
        ),
      ).rejects.toThrow();

      await applyCompiledQueries(postgres, await compileMigration(downMachineOwnedWorkspaces));
      const downgraded = await postgres.query<{ workspace_kind: string }>(
        "select workspace_kind from workspaces where id = $1",
        ["10000000-0000-4000-8000-000000000002"],
      );
      expect(downgraded.rows).toEqual([{ workspace_kind: "user" }]);
      const legacyModes = await postgres.query<{ sandbox_retention_policy: string }>(
        "select sandbox_retention_policy from sessions order by id",
      );
      expect(legacyModes.rows).toEqual([
        { sandbox_retention_policy: "ephemeral" },
        { sandbox_retention_policy: "persistent" },
      ]);
    } finally {
      await postgres.close();
    }
  });
});
