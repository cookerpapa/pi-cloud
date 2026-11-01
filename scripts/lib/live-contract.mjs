import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { migrationProvider } from "../../packages/database/src/migrations/index.ts";

export function validateLiveContract({
  migrations,
  databaseSchema,
  deployment,
  requiredContracts = {},
}) {
  const sourceSchema = Object.keys(migrations).sort().at(-1);
  assert(sourceSchema, "Source migration contract is empty");
  assert.equal(
    databaseSchema,
    sourceSchema,
    "Deploy the current source schema before live acceptance",
  );
  assert.equal(deployment.formatVersion, 1, "Unsupported deployment manifest");
  assert.equal(
    deployment.contracts?.schema,
    sourceSchema,
    "Serving manifest and database schema differ",
  );
  for (const [name, version] of Object.entries(requiredContracts))
    assert.equal(deployment.contracts?.[name], version, `Required live contract changed: ${name}`);
  return { schema: sourceSchema, deploymentRevision: deployment.revision, requiredContracts };
}

/** Read-only acceptance preflight, never migrations or a substitute for artifact verification. */
export async function assertLiveContract(database, runtimeDirectory, requiredContracts = {}) {
  const [schema, migrations, manifest] = await Promise.all([
    database
      .selectFrom("kysely_migration")
      .select("name")
      .orderBy("name", "desc")
      .limit(1)
      .executeTakeFirstOrThrow(),
    migrationProvider.getMigrations(),
    readFile(resolve(runtimeDirectory, "k3s/deployment.json"), "utf8"),
  ]);
  return validateLiveContract({
    migrations,
    databaseSchema: schema.name,
    deployment: JSON.parse(manifest),
    requiredContracts,
  });
}
