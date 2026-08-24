import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  downDevelopmentEnvironmentRecoveryIdentity,
  upDevelopmentEnvironmentRecoveryIdentity,
} from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

describe("development machine recovery identity migration", () => {
  it("retains a complete physical identity while ownership is uncertain", async () => {
    const postgres = await PGlite.create();
    try {
      await postgres.exec(`
        create table development_environments (
          id uuid primary key,
          state text not null,
          runtime_id text,
          runtime_name text,
          constraint development_environments_runtime_shape check (
            (state in ('running', 'paused') and runtime_id is not null and runtime_name is not null)
            or (state not in ('running', 'paused') and runtime_id is null and runtime_name is null)
          )
        );
        insert into development_environments values (
          '10000000-0000-4000-8000-000000000001',
          'running',
          'cube-physical-id',
          'pi-cloud-machine'
        );
      `);

      await applyCompiledQueries(
        postgres,
        await compileMigration(upDevelopmentEnvironmentRecoveryIdentity),
      );
      await expect(
        postgres.query("update development_environments set state = 'unknown' where id = $1", [
          "10000000-0000-4000-8000-000000000001",
        ]),
      ).resolves.toBeDefined();
      await expect(
        postgres.query("update development_environments set state = 'releasing' where id = $1", [
          "10000000-0000-4000-8000-000000000001",
        ]),
      ).resolves.toBeDefined();
      await expect(
        postgres.query("update development_environments set runtime_name = null where id = $1", [
          "10000000-0000-4000-8000-000000000001",
        ]),
      ).rejects.toThrow();

      await applyCompiledQueries(
        postgres,
        await compileMigration(downDevelopmentEnvironmentRecoveryIdentity),
      );
      const result = await postgres.query<{
        runtime_id: string | null;
        runtime_name: string | null;
      }>("select runtime_id, runtime_name from development_environments");
      expect(result.rows).toEqual([{ runtime_id: null, runtime_name: null }]);
    } finally {
      await postgres.close();
    }
  });
});
