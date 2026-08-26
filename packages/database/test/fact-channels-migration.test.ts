import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { sql } from "kysely";
import { createDatabase, runMigrations } from "../src/index.ts";
import { afterEach, describe, expect, it } from "vitest";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

describe("fact channel migration", () => {
  it("renames the active accepted-Fact channel ownership columns", async () => {
    const pglite = await PGlite.create();
    const socket = new PGLiteSocketServer({ db: pglite, host: "127.0.0.1", port: 0 });
    await socket.start();
    const database = createDatabase({
      connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
      maxConnections: 2,
    });
    resources.push(async () => pglite.close());
    resources.push(async () => socket.stop());
    resources.push(async () => database.destroy());

    await runMigrations(database, "up");

    const columns = await sql<{ column_name: string }>`
      select column_name
        from information_schema.columns
       where table_name = 'execution_grants'
         and column_name like 'fact_channel_%'
       order by column_name
    `.execute(database);
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "fact_channel_connection_id",
      "fact_channel_instance_id",
      "fact_channel_valid_until",
    ]);

    const constraints = await sql<{ name: string }>`
      select conname as name
        from pg_constraint
       where conname = 'execution_grants_fact_channel_complete'
    `.execute(database);
    expect(constraints.rows).toEqual([{ name: "execution_grants_fact_channel_complete" }]);
  }, 20_000);
});
