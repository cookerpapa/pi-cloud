import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { expect, it, vi } from "vitest";
import { createDatabase } from "../src/client.ts";

it.skipIf(!process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL)(
  "reports slow committed transport time without leaking SQL or bound data",
  async () => {
    const db = createDatabase({
      connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!,
      maxConnections: 1,
    });
    const table = `commit_probe_${randomUUID().replaceAll("-", "")}`;
    const logs: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((line) => {
      logs.push(String(line));
    });
    try {
      await sql`create table ${sql.id(table)} (value text)`.execute(db);
      await sql`create function ${sql.id(table)}() returns trigger language plpgsql as 'begin perform pg_sleep(0.12); return new; end'`.execute(
        db,
      );
      await sql`create constraint trigger slow_commit after insert on ${sql.id(table)} deferrable initially deferred for each row execute function ${sql.id(table)}()`.execute(
        db,
      );
      await db.transaction().execute(async (tx) => {
        await sql`insert into ${sql.id(table)} values (${"do-not-log-this-bound-value"})`.execute(
          tx,
        );
      });
      const events = logs
        .map((line) => JSON.parse(line))
        .filter((e) => e.event === "database.slow_commit");
      expect(events).toHaveLength(1);
      expect(events[0].durationMs).toBeGreaterThanOrEqual(100);
      expect(events[0].backendPid).toBeGreaterThan(0);
      expect(events[0].eventLoopIdleMs).toBeGreaterThan(0);
      expect(events[0].eventLoopActiveMs).toBeGreaterThanOrEqual(0);
      expect(logs.join("\n")).not.toContain("do-not-log");
      expect(logs.join("\n")).not.toContain(table);
      expect(
        (await sql<{ n: number }>`select count(*)::int n from ${sql.id(table)}`.execute(db))
          .rows[0]!.n,
      ).toBe(1);
      warn.mockImplementationOnce(() => {
        throw new Error("diagnostic sink unavailable");
      });
      await expect(
        db.transaction().execute(async (tx) => {
          await sql`insert into ${sql.id(table)} values (${"also-private"})`.execute(tx);
        }),
      ).resolves.toBeUndefined();
      expect(
        (await sql<{ n: number }>`select count(*)::int n from ${sql.id(table)}`.execute(db))
          .rows[0]!.n,
      ).toBe(2);
    } finally {
      warn.mockRestore();
      try {
        await sql`drop table if exists ${sql.id(table)}`.execute(db);
        await sql`drop function if exists ${sql.id(table)}()`.execute(db);
      } finally {
        await db.destroy();
      }
    }
  },
);
