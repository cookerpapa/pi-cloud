import { createServer, connect, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { describe, it, expect, vi } from "vitest";
import { createDatabase } from "../src/client.ts";

const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
describe.skipIf(!endpoint)("bounded authority connection checkout", () => {
  it("evicts a held transaction, rolls it back and releases capacity before its caller returns", async () => {
    const db = createDatabase({
      connectionString: endpoint!,
      maxConnections: 1,
      checkoutTimeoutMs: 300,
    });
    const admin = createDatabase({ connectionString: endpoint!, maxConnections: 1 });
    const table = `lease_budget_${randomUUID().replaceAll("-", "")}`;
    const entered = Promise.withResolvers<number>(),
      proceed = Promise.withResolvers<void>();
    await sql`create table ${sql.id(table)}(n integer)`.execute(admin);
    const held = db.transaction().execute(async (tx) => {
      const pid = (await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(tx)).rows[0]!
        .pid;
      await sql`insert into ${sql.id(table)} values(1)`.execute(tx);
      entered.resolve(pid);
      await proceed.promise;
      await sql`insert into ${sql.id(table)} values(2)`.execute(tx);
    });
    const rejected = expect(held).rejects.toBeInstanceOf(Error);
    try {
      const oldPid = await entered.promise;
      // A caller already waiting can consume its own acquisition budget while
      // pg destroys/replaces the old socket. That refusal is valid and bounded.
      const waiting = sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db).then(
        (result) => result.rows[0]!.pid,
        (error: Error) => {
          expect(error.message).toContain("timeout");
          return undefined;
        },
      );
      await vi.waitFor(async () => {
        expect(
          (
            await sql<{
              n: number;
            }>`select count(*)::int n from pg_stat_activity where pid=${oldPid}`.execute(admin)
          ).rows[0]!.n,
        ).toBe(0);
      });
      const waiterPid = await waiting;
      if (waiterPid !== undefined) expect(waiterPid).not.toBe(oldPid);
      const next = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(db);
      expect(next.rows[0]!.pid).not.toBe(oldPid);
      expect(
        (await sql<{ n: number }>`select count(*)::int n from ${sql.id(table)}`.execute(admin))
          .rows[0]!.n,
      ).toBe(0);
    } finally {
      proceed.resolve();
      await rejected;
      await db.destroy();
      await sql`drop table ${sql.id(table)}`.execute(admin);
      await admin.destroy();
    }
  });

  it("bounds the whole transaction rather than granting a fresh budget per SQL", async () => {
    const db = createDatabase({
      connectionString: endpoint!,
      maxConnections: 1,
      checkoutTimeoutMs: 250,
    });
    let completed = 0;
    try {
      await expect(
        db.transaction().execute(async (tx) => {
          for (let i = 0; i < 20; i++) {
            await sql`select pg_sleep(0.05)`.execute(tx);
            completed++;
          }
        }),
      ).rejects.toBeInstanceOf(Error);
      expect(completed).toBeLessThan(20);
      expect((await sql<{ n: number }>`select 1 n`.execute(db)).rows[0]!.n).toBe(1);
    } finally {
      await db.destroy();
    }
  });

  it("rejects a lost COMMIT reply without retrying a committed effect and removes the socket", async () => {
    const url = new URL(endpoint!);
    const sockets = new Set<Socket>();
    let blockCommit = true,
      commits = 0;
    const server = createServer((client) => {
      const upstream = connect({ host: url.hostname, port: Number(url.port || 5432) });
      sockets.add(client);
      sockets.add(upstream);
      let withheld = false,
        tail = Buffer.alloc(0);
      client.on("data", (bytes) => {
        tail = Buffer.concat([tail, bytes]).subarray(-100);
        if (blockCommit && tail.includes(Buffer.from("commit\0"))) {
          withheld = true;
          blockCommit = false;
          commits++;
        }
        upstream.write(bytes);
      });
      upstream.on("data", (bytes) => {
        if (!withheld) client.write(bytes);
      });
      for (const socket of [client, upstream]) socket.on("error", () => {});
      client.on("close", () => {
        sockets.delete(client);
        upstream.destroy();
      });
      upstream.on("close", () => {
        sockets.delete(upstream);
        client.destroy();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const proxy = new URL(url);
    proxy.hostname = "127.0.0.1";
    proxy.port = String((server.address() as { port: number }).port);
    const db = createDatabase({
      connectionString: proxy.toString(),
      maxConnections: 1,
      checkoutTimeoutMs: 500,
    });
    const admin = createDatabase({ connectionString: endpoint!, maxConnections: 1 });
    const table = `lease_commit_${randomUUID().replaceAll("-", "")}`;
    await sql`create table ${sql.id(table)}(n integer)`.execute(admin);
    let pid = 0;
    try {
      const pending = db.transaction().execute(async (tx) => {
        pid = (await sql<{ pid: number }>`select pg_backend_pid() pid`.execute(tx)).rows[0]!.pid;
        await sql`insert into ${sql.id(table)} values(1)`.execute(tx);
      });
      const rejected = expect(pending).rejects.toBeInstanceOf(Error);
      await rejected;
      expect(commits).toBe(1);
      expect(
        (await sql<{ n: number }>`select count(*)::int n from ${sql.id(table)}`.execute(admin))
          .rows[0]!.n,
      ).toBe(1);
      await vi.waitFor(async () => {
        expect(
          (
            await sql<{
              n: number;
            }>`select count(*)::int n from pg_stat_activity where pid=${pid}`.execute(admin)
          ).rows[0]!.n,
        ).toBe(0);
      });
      expect((await sql<{ n: number }>`select 2 n`.execute(db)).rows[0]!.n).toBe(2);
    } finally {
      await db.destroy();
      await sql`drop table ${sql.id(table)}`.execute(admin);
      await admin.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("bounds connection establishment when the peer accepts TCP but never answers", async () => {
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.on("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = new URL(endpoint!);
    url.hostname = "127.0.0.1";
    url.port = String((server.address() as { port: number }).port);
    const db = createDatabase({
      connectionString: url.toString(),
      maxConnections: 1,
      checkoutTimeoutMs: 250,
    });
    try {
      await expect(sql`select 1`.execute(db)).rejects.toBeInstanceOf(Error);
    } finally {
      await db.destroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
