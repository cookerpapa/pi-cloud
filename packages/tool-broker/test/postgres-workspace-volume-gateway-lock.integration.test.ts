import { Pool, type PoolClient } from "pg";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PostgresWorkspaceVolumeGatewayLock } from "../src/index.ts";

const connectionString = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
const resources: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const close of resources.splice(0).reverse()) await close();
});

describe.skipIf(connectionString === undefined)("PostgreSQL Workspace Volume Gateway lock", () => {
  it("discards an uncertain unlock connection and preserves the original filesystem error", async () => {
    const pool = new Pool({ connectionString: connectionString!, max: 1 });
    const observer = new Pool({ connectionString: connectionString!, max: 1 });
    resources.push(
      async () => pool.end(),
      async () => observer.end(),
    );
    let first: PoolClient | undefined,
      failUnlock = true;
    pool.on("connect", (client) => {
      first ??= client as PoolClient;
      const query = client.query;
      client.query = ((...args: unknown[]) => {
        if (args[0] === "select pg_advisory_unlock_all()" && failUnlock) {
          failUnlock = false;
          return Promise.reject(new Error("unlock reply lost"));
        }
        return Reflect.apply(query, client, args);
      }) as typeof client.query;
    });
    const lock = new PostgresWorkspaceVolumeGatewayLock(pool);
    const id = `pcw-integration-${randomUUID()}`;
    let pid: number | undefined;
    await expect(
      lock.withLock(id, async () => {
        pid = (await first!.query("select pg_backend_pid() pid")).rows[0].pid;
        throw new Error("filesystem failed");
      }),
    ).rejects.toThrow("filesystem failed");
    const replacement = (await pool.query("select pg_backend_pid() pid")).rows[0].pid;
    expect(replacement).not.toBe(pid);
    const acquired = await observer.query(
      "select pg_try_advisory_lock(hashtextextended($1,0)) locked",
      [`pi-cloud.workspace.${id}`],
    );
    expect(acquired.rows[0].locked).toBe(true);
    await observer.query("select pg_advisory_unlock_all()");
  });

  it("refuses a successful callback result if its lock session was lost during work", async () => {
    const pool = new Pool({ connectionString: connectionString!, max: 1 });
    const observer = new Pool({ connectionString: connectionString!, max: 1 });
    resources.push(
      async () => pool.end(),
      async () => observer.end(),
    );
    let current: PoolClient | undefined;
    pool.on("connect", (client) => {
      current = client as PoolClient;
    });
    const lock = new PostgresWorkspaceVolumeGatewayLock(pool);
    await expect(
      lock.withLock(`pcw-integration-${randomUUID()}`, async () => {
        const pid = (await current!.query("select pg_backend_pid() pid")).rows[0].pid;
        const disconnected = new Promise<void>((resolve) =>
          current!.once("error", () => resolve()),
        );
        await observer.query("select pg_terminate_backend($1)", [pid]);
        await disconnected;
        return "must not acknowledge this as protected";
      }),
    ).rejects.toBeDefined();
  });
  it("serializes one shared Volume across independent service connections", async () => {
    const firstDatabase = new Pool({
      connectionString: connectionString!,
      max: 1,
    });
    const secondDatabase = new Pool({
      connectionString: connectionString!,
      max: 1,
    });
    resources.push(async () => firstDatabase.end());
    resources.push(async () => secondDatabase.end());

    const first = new PostgresWorkspaceVolumeGatewayLock(firstDatabase);
    const second = new PostgresWorkspaceVolumeGatewayLock(secondDatabase);
    const events: string[] = [];
    let releaseFirst!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const volumeId = `pcw-integration-${randomUUID()}`;
    const firstRun = first.withLock(volumeId, async () => {
      events.push("first-start");
      await held;
      events.push("first-end");
    });
    await vi.waitFor(() => expect(events).toEqual(["first-start"]));
    const secondRun = second.withLock(volumeId, async () => {
      events.push("second-start", "second-end");
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toEqual(["first-start"]);
    releaseFirst();
    await Promise.all([firstRun, secondRun]);
    expect(events).toEqual(["first-start", "first-end", "second-start", "second-end"]);
  });

  it("holds multiple ordered Volume locks on one bounded database connection", async () => {
    const database = new Pool({ connectionString: connectionString!, max: 1 });
    resources.push(async () => database.end());
    const lock = new PostgresWorkspaceVolumeGatewayLock(database);
    const volumes = [`pcw-integration-${randomUUID()}`, `pcw-integration-${randomUUID()}`];
    await expect(lock.withLocks(volumes.reverse(), async () => "forked")).resolves.toBe("forked");
  });
});
