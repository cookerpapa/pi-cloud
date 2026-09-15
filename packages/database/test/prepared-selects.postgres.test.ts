import { CompiledQuery, sql } from "kysely";
import { expect, it, vi } from "vitest";
import { createDatabase } from "../src/client.ts";

const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;

it.skipIf(!endpoint)(
  "reuses bounded SELECT plans without changing bindings or transactions",
  async () => {
    const database = createDatabase({ connectionString: endpoint!, maxConnections: 1 });
    try {
      await database.connection().execute(async (connection) => {
        const value = { text: "中文 ' quote", list: [1, null, true] };
        for (let i = 0; i < 20; i++) {
          const result = await sql<{ n: number; body: typeof value; large: string }>`
          select ${i}::int as n, ${JSON.stringify(value)}::jsonb as body,
                 ${"9007199254740993"}::bigint as large
        `.execute(connection);
          expect(result.rows).toEqual([{ n: i, body: value, large: "9007199254740993" }]);
        }
        // Repeated values share one statement, not one result cache.
        const statement = "select $1::int as n";
        for (let i = 0; i < 20; i++) {
          const result = await connection.executeQuery<{ n: number }>(
            CompiledQuery.raw(statement, [i]),
          );
          expect(result.rows).toEqual([{ n: i }]);
        }
        const before = await sql<{ statement: string; generic_plans: string }>`
        select statement, generic_plans from pg_prepared_statements
        where name like 'pc_%'
      `.execute(connection);
        expect(before.rows.filter((row) => row.statement === statement)).toHaveLength(1);
        expect(
          Number(before.rows.find((row) => row.statement === statement)!.generic_plans),
        ).toBeGreaterThan(0);

        for (let i = 0; i < 160; i++) {
          const result = await connection.executeQuery<{ n: number }>(
            CompiledQuery.raw(`select $1::int as n /* shape ${i} */`, [i]),
          );
          expect(result.rows).toEqual([{ n: i }]);
        }
        const count = await sql<{ n: string }>`
        select count(*)::text as n from pg_prepared_statements where name like 'pc_%'
      `.execute(connection);
        expect(Number(count.rows[0]!.n)).toBe(128);
        // A full plan cache is not an execution quota, nor does it evict/reuse names.
        expect((await connection.executeQuery(CompiledQuery.raw(statement, [999]))).rows).toEqual([
          { n: 999 },
        ]);
        await sql`create temporary table prepared_rollback (n integer)`.execute(connection);
      });
      const failure = new Error("rollback fixture");
      await expect(
        database.transaction().execute(async (tx) => {
          await sql`insert into prepared_rollback values (${1})`.execute(tx);
          await sql`select n from prepared_rollback where n = ${1}`.execute(tx);
          throw failure;
        }),
      ).rejects.toBe(failure);
      expect((await sql`select * from prepared_rollback`.execute(database)).rows).toEqual([]);
    } finally {
      await database.destroy();
    }
  },
);

it.skipIf(!endpoint)(
  "cancels a prepared query with a full pool without replacing its session",
  async () => {
    const database = createDatabase({ connectionString: endpoint!, maxConnections: 1 });
    const observer = createDatabase({ connectionString: endpoint!, maxConnections: 1 });
    const controller = new AbortController();
    let stopped: Promise<unknown> | undefined;
    try {
      const { pid } = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(database))
        .rows[0]!;
      stopped = sql`select pg_sleep(${30})`
        .execute(database, {
          signal: controller.signal,
          inflightQueryAbortStrategy: "cancel query",
        })
        .catch((error) => error);
      await vi.waitFor(
        async () => {
          const state = await sql<{ wait_event: string | null }>`
        select wait_event from pg_stat_activity where pid = ${pid}
      `.execute(observer);
          expect(state.rows[0]?.wait_event).toBe("PgSleep");
        },
        { timeout: 2_000 },
      );
      controller.abort(new Error("owned query cancellation"));
      expect(await stopped).toBeInstanceOf(Error);
      expect(
        (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(database)).rows,
      ).toEqual([{ pid }]);
    } finally {
      controller.abort();
      await stopped;
      await database.destroy();
      await observer.destroy();
    }
  },
);
