import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { afterEach, describe, expect, it } from "vitest";
import { sql } from "kysely";
import { createDatabase, runMigrations } from "../src/index.ts";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

describe("Sandbox HTTP service discovery migration", () => {
  it("creates a tenant-scoped active-service registry with one runtime-port identity", async () => {
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
         and table_name = 'sandbox_http_services'
    `.execute(database);
    const names = new Set(columns.rows.map((column) => column.column_name));
    for (const name of [
      "tenant_id",
      "target_kind",
      "target_id",
      "runtime_id",
      "port",
      "state",
      "last_seen_at",
    ]) {
      expect(names).toContain(name);
    }
  }, 20_000);
});
