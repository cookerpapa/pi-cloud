import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { sql } from "kysely";
import { expect, it } from "vitest";
import { createDatabase } from "../src/client.ts";

it("keeps statement names independent when clients share a PostgreSQL backend", async () => {
  const engine = await PGlite.create();
  const server = new PGLiteSocketServer({
    db: engine,
    host: "127.0.0.1",
    port: 0,
    maxConnections: 2,
  });
  await server.start();
  const options = {
    connectionString: `postgresql://postgres@${server.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 1,
  };
  const first = createDatabase(options),
    second = createDatabase(options);
  try {
    for (let i = 0; i < 4; i++) {
      expect((await sql`select ${i}::int as n`.execute(first)).rows).toEqual([{ n: i }]);
      expect((await sql`select ${i + 10}::int as n`.execute(second)).rows).toEqual([{ n: i + 10 }]);
    }
  } finally {
    await first.destroy();
    await second.destroy();
    await server.stop();
    await engine.close();
  }
});
