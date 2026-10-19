import { sql } from "kysely";
import { expect, it, vi } from "vitest";
import { createDatabase, withDatabaseReadSignal } from "../src/client.ts";

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

it.skipIf(!process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL)(
  "cancels the actual read backend and replaces it without affecting authority work",
  async () => {
    const connectionString = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!;
    const reads = createDatabase({ connectionString, maxConnections: 1, readTimeoutMs: 5_000 });
    const authority = createDatabase({ connectionString, maxConnections: 1 });
    const abort = new AbortController(),
      entered = Promise.withResolvers<number>();
    const reason = new Error("Owned read cancelled");
    const pending = withDatabaseReadSignal(abort.signal, () =>
      reads.connection().execute(async (db) => {
        const pid = (await sql<{ pid: number }>`select pg_backend_pid() pid`.execute(db)).rows[0]!
          .pid;
        entered.resolve(pid);
        await sql`select pg_sleep(20)`.execute(db);
      }),
    );
    const rejected = expect(pending).rejects.toBe(reason);
    try {
      const pid = await entered.promise;
      await vi.waitFor(async () => {
        expect(
          (
            await sql<{
              n: number;
            }>`select count(*)::int n from pg_stat_activity where pid=${pid} and wait_event='PgSleep'`.execute(
              authority,
            )
          ).rows[0]!.n,
        ).toBe(1);
      });
      abort.abort(reason);
      await rejected;
      await vi.waitFor(
        async () => {
          expect(
            (
              await sql<{
                n: number;
              }>`select count(*)::int n from pg_stat_activity where pid=${pid}`.execute(authority)
            ).rows[0]!.n,
          ).toBe(0);
        },
        { timeout: 3_000 },
      );
      const next = await sql<{ pid: number }>`select pg_backend_pid() pid`.execute(reads);
      expect(next.rows[0]!.pid).not.toBe(pid);
      // A read cancellation scope must not cancel authority SQL or COMMIT.
      const other = new AbortController();
      const write = withDatabaseReadSignal(other.signal, () =>
        sql`select pg_sleep(0.05)`.execute(authority),
      );
      other.abort(reason);
      await write;
    } finally {
      abort.abort(reason);
      await rejected;
      await reads.destroy();
      await authority.destroy();
    }
  },
);

it.skipIf(!process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL)(
  "rejects a cancelled acquisition promptly and never runs its late SQL",
  async () => {
    const reads = createDatabase({
      connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!,
      maxConnections: 1,
      readTimeoutMs: 1_000,
    });
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const held = reads.connection().execute(async (db) => {
      await sql`select 1`.execute(db);
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const abort = new AbortController(),
      reason = "Queued read cancelled";
    const pending = withDatabaseReadSignal(abort.signal, () =>
      sql`select pg_sleep(20)`.execute(reads),
    );
    const rejected = expect(pending).rejects.toBe(reason);
    try {
      // Let Kysely reach the already-initialized pool's queued acquisition.
      await new Promise<void>((resolve) => setImmediate(resolve));
      abort.abort(reason);
      await rejected;
      release.resolve();
      await held;
      const started = performance.now();
      expect((await sql<{ n: number }>`select 2 n`.execute(reads)).rows[0]!.n).toBe(2);
      expect(performance.now() - started).toBeLessThan(700);
    } finally {
      release.resolve();
      await held;
      await rejected;
      await reads.destroy();
    }
  },
);
