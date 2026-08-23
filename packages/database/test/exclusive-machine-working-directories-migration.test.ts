import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import {
  downExclusiveMachineWorkingDirectories,
  upExclusiveMachineWorkingDirectories,
} from "../src/index.ts";
import { applyCompiledQueries, compileMigration } from "./postgres-test-harness.ts";

describe("exclusive machine working-directory migration", () => {
  it("admits canonical guest paths while rejecting traversal", async () => {
    const postgres = await PGlite.create();
    try {
      await postgres.exec(`
        create table sessions (
          id uuid primary key,
          working_directory text not null,
          constraint sessions_working_directory_valid
            check (working_directory ~ '^/workspace(?:/[A-Za-z0-9._-]+)*$')
        );
        create table runs (
          id uuid primary key,
          working_directory text not null,
          constraint runs_working_directory_valid
            check (working_directory ~ '^/workspace(?:/[A-Za-z0-9._-]+)*$')
        );
      `);
      await applyCompiledQueries(
        postgres,
        await compileMigration(upExclusiveMachineWorkingDirectories),
      );
      await expect(
        postgres.query("insert into sessions values ($1, '/home/node/empty project')", [
          "10000000-0000-4000-8000-000000000001",
        ]),
      ).resolves.toBeDefined();
      await expect(
        postgres.query("insert into runs values ($1, '/home/node/../root')", [
          "10000000-0000-4000-8000-000000000002",
        ]),
      ).rejects.toThrow();
      await postgres.query("delete from sessions");
      await applyCompiledQueries(
        postgres,
        await compileMigration(downExclusiveMachineWorkingDirectories),
      );
    } finally {
      await postgres.close();
    }
  });
});
