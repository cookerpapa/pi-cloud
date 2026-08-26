import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createDatabase, runMigrations } from "../src/index.ts";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

describe("Agent EventWriterChannel migration", () => {
  it("adds one complete short writer identity to the current ExecutionGrant", async () => {
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
       where table_schema = 'public'
         and table_name = 'execution_grants'
         and column_name like 'event_writer_%'
       order by column_name
    `.execute(database);
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "event_writer_connection_id",
      "event_writer_instance_id",
      "event_writer_valid_until",
    ]);

    const constraints = await sql<{ name: string }>`
      select conname as name
        from pg_constraint
       where conname = 'execution_grants_event_writer_complete'
    `.execute(database);
    expect(constraints.rows).toEqual([{ name: "execution_grants_event_writer_complete" }]);
  }, 20_000);
});
