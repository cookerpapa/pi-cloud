import { sql } from "kysely";
import { expect, it } from "vitest";
import { createDatabase } from "../src/client.ts";

it.skipIf(!process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL)(
  "terminates slow disposable reads without blocking the authority pool",
  async () => {
    const connectionString = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!;
    const reads = createDatabase({ connectionString, maxConnections: 1, readTimeoutMs: 500 });
    const authority = createDatabase({ connectionString, maxConnections: 1 });
    try {
      const slow = sql`select pg_sleep(10)`.execute(reads);
      const stopped = expect(slow).rejects.toMatchObject({ code: "57014" });
      expect((await sql<{ n: number }>`select 1 as n`.execute(authority)).rows[0]?.n).toBe(1);
      await stopped;
      expect((await sql<{ n: number }>`select 2 as n`.execute(reads)).rows[0]?.n).toBe(2);
    } finally {
      await reads.destroy();
      await authority.destroy();
    }
  },
);
