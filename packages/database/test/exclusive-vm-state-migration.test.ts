import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { downExclusiveVmState, upExclusiveVmState } from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

describe("exclusive full-VM state migration", () => {
  it("adds bounded encrypted reconnect state", async () => {
    const postgres = await PGlite.create();
    try {
      await postgres.exec(`
        create table development_environments (
          id uuid primary key,
          tenant_id uuid not null,
          workspace_id uuid not null,
          state text not null,
          unique (tenant_id, id)
        );
        create table sessions (
          id uuid primary key,
          tenant_id uuid not null,
          workspace_id uuid not null,
          sandbox_retention_policy text not null
        );
      `);
      await applyCompiledQueries(postgres, await compileMigration(upExclusiveVmState));
      await postgres.query(
        `insert into development_environments
           (id, tenant_id, workspace_id, state, runtime_capsule)
         values ($1, '20000000-0000-4000-8000-000000000001',
                 '30000000-0000-4000-8000-000000000001', 'paused', $2)`,
        ["10000000-0000-4000-8000-000000000001", `pcvm1_${"a".repeat(80)}`],
      );
      await expect(
        postgres.query(
          `insert into development_environments
             (id, tenant_id, workspace_id, state, runtime_capsule)
           values ($1, '20000000-0000-4000-8000-000000000001',
                   '30000000-0000-4000-8000-000000000002', 'paused', 'short')`,
          ["10000000-0000-4000-8000-000000000002"],
        ),
      ).rejects.toThrow();
      await applyCompiledQueries(postgres, await compileMigration(downExclusiveVmState));
    } finally {
      await postgres.close();
    }
  });
});
