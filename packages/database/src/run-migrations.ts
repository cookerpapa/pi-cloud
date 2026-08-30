import { Migrator, type MigrationResult } from "kysely/migration";
import type { Kysely } from "kysely";
import type { Database } from "./database-types.ts";
import { migrationProvider } from "./migrations/index.ts";

export type MigrationDirection = "up" | "down";

export type MigrationRunResult = {
  direction: MigrationDirection;
  results: readonly MigrationResult[];
};

export async function runMigrations(
  db: Kysely<Database>,
  direction: MigrationDirection,
): Promise<MigrationRunResult> {
  // Migration filenames carry the immutable order. Kysely otherwise orders
  // already-applied rows by wall-clock timestamps, which can move backwards on
  // a resumed VM/WSL host and falsely report a valid numeric chain as corrupt.
  // Down migrations are not a supported recovery mechanism in this pre-release
  // schema; destructive cutovers require restoring a backup.
  const migrator = new Migrator({
    db,
    provider: migrationProvider,
    allowUnorderedMigrations: true,
  });
  const result =
    direction === "up" ? await migrator.migrateToLatest() : await migrator.migrateDown();
  if (result.error) {
    throw result.error;
  }
  return {
    direction,
    results: result.results ?? [],
  };
}
