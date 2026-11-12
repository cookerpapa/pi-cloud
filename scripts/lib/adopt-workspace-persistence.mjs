import assert from "node:assert/strict";
import { CompiledQuery } from "kysely";
import { adoptWorkspacePersistenceDomain } from "../../packages/sandbox-control/src/postgres-workspace-persistence.ts";
import { withVerifiedWorkspaceStorage } from "./workspace-storage-pool.mjs";

/** This is an explicit matched cutover, with no file copy or ordinary-mode repair. */
export async function adoptMatchedWorkspacePersistence(options, guard) {
  assert(
    guard.mode === "online" && guard.database,
    "Storage adoption requires online PG and cold physical proof",
  );
  await guard.assertQuiescent();
  const schema = await guard.database.executeQuery(
    CompiledQuery.raw("select name from kysely_migration where name='221_workspace_persistence'"),
  );
  assert.equal(schema.rows.length, 1, "Install Workspace persistence authority before adoption");
  const database = {
    query: async (text, values = []) => {
      const result = await guard.database.executeQuery(CompiledQuery.raw(text, values));
      return { rows: result.rows, rowCount: Number(result.numAffectedRows ?? result.rows.length) };
    },
  };
  return withVerifiedWorkspaceStorage(
    { ...options, assertQuiescent: guard.assertQuiescent },
    async (request) => {
      const result = await adoptWorkspacePersistenceDomain(
        {
          database,
          storage: {
            pool: () => request("/v1/pool"),
            inspectStorage: (input) => request("/v1/storage/inspect", input),
            prepareStorage: async (input) => {
              await guard.assertQuiescent();
              return request("/v1/storage/prepare", input);
            },
            destroyStorage: async () => {
              throw new Error("Adoption cannot delete Workspace bytes");
            },
          },
        },
        options.domainId,
      );
      await guard.assertQuiescent();
      return result;
    },
  );
}
