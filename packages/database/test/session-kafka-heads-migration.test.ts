import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations } from "../src/index.ts";
import { sql } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

describe("Session Kafka head migration", () => {
  it("adds one canonical Kafka boundary per Session", async () => {
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
       where table_name = 'session_kafka_heads'
       order by ordinal_position
    `.execute(database);
    expect(columns.rows.map((row) => row.column_name)).toEqual([
      "tenant_id",
      "session_id",
      "topic",
      "kafka_partition",
      "kafka_offset",
      "canonical_event_seq",
      "updated_at",
    ]);
  }, 20_000);
});
