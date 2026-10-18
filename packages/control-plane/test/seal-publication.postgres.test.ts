// ADR-0260: real disposable PG and loopback HTTP publication regressions.
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import { sql } from "kysely";
import { expect, it, vi } from "vitest";
import type { KafkaSessionWriter } from "@pi-cloud/event-log";
import { createDatabase } from "@pi-cloud/database";
import { PublicationNotSentError } from "@pi-cloud/protocol";
import { nativeSubagentFixture } from "./native-subagent-fixture.ts";
import { requestExecutionStreamSeal } from "../../runtime-core/src/execution-stream-seal.ts";
import { PostgresPublicationControl } from "../../runtime-core/src/postgres-publication-control.ts";
import { SessionOutboxRelay } from "../../runtime-core/src/session-outbox-relay.ts";
import {
  HttpPublicationClient,
  PUBLICATION_PATH,
} from "../../runtime-core/src/http-publication-client.ts";
import { PostgresSandboxBindings } from "../../sandbox-control/src/sandbox-bindings.ts";
import type { AcceptedExecutionSealFact } from "../../runtime-core/src/accepted-fact.ts";

async function listen(server: Server) {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
async function close(server: Server) {
  server.closeAllConnections();
  if (server.listening)
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
}
function fact(): AcceptedExecutionSealFact {
  const id = randomUUID();
  return {
    kind: "execution_seal",
    factId: randomUUID(),
    agentId: "root",
    baseSequence: 0,
    recover: true,
    occurredAt: new Date().toISOString(),
    scope: {
      tenantId: randomUUID(),
      piSessionId: id,
      sessionId: id,
      runId: randomUUID(),
      turnId: randomUUID(),
      writerId: randomUUID(),
      fencingToken: 1,
    },
  };
}
async function request(f: Awaited<ReturnType<typeof nativeSubagentFixture>>) {
  const id = randomUUID();
  await f.database.transaction().execute((tx) =>
    requestExecutionStreamSeal(tx, {
      tenantId: f.scope.tenantId,
      sessionId: f.scope.sessionId,
      turnId: f.scope.turnId,
      runId: f.scope.runId,
      agentId: "root",
      now: new Date(),
      eventId: id,
      recover: true,
    }),
  );
  return (
    await f.database
      .selectFrom("outbox")
      .select("payload")
      .where("id", "=", id)
      .executeTakeFirstOrThrow()
  ).payload as unknown as AcceptedExecutionSealFact;
}

it("rediscovers a closed cached peer on the next immutable-Fact retry", async () => {
  const calls = { router: 0, old: 0, current: 0 };
  let target = "";
  const endpoint = (kind: "old" | "current") =>
    createServer(async (req, res) => {
      calls[kind]++;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ factId: body.factId, durable: true }));
    });
  const old = endpoint("old"),
    current = endpoint("current");
  const router = createServer((_req, res) => {
    calls.router++;
    res.writeHead(307, { location: target + PUBLICATION_PATH + "/seal" });
    res.end();
  });
  const clients: HttpPublicationClient[] = [];
  try {
    target = await listen(old);
    const next = await listen(current),
      base = await listen(router);
    const client = new HttpPublicationClient({
      baseUrl: base,
      token: "review-only",
      timeoutMs: 500,
    });
    clients.push(client);
    const first = fact();
    await expect(client.publishSeal(first)).resolves.toMatchObject({ durable: true });
    target = next;
    await close(old);
    const retry = { ...first, factId: randomUUID() };
    const failure = await client.publishSeal(retry).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(PublicationNotSentError);
    expect(calls).toEqual({ router: 1, old: 1, current: 0 });
    await expect(client.publishSeal(retry)).resolves.toMatchObject({
      factId: retry.factId,
      durable: true,
    });
    expect(calls.router).toBe(2);
    expect(calls.current).toBe(1);
  } finally {
    await Promise.allSettled(clients.map((c) => c.close()));
    await Promise.all([close(router), close(old), close(current)]);
  }
});

it.skipIf(!process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL)(
  "bounds a locked relay claim, stops admission and preserves its retriable seal",
  async () => {
    const f = await nativeSubagentFixture(),
      locked = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let blocker: Promise<void> | undefined,
      closing: Promise<void> | undefined,
      closed = false;
    const database = createDatabase({
      connectionString: f.url,
      maxConnections: 2,
      checkoutTimeoutMs: 250,
    });
    const append = vi.fn(async (item: { factId: string }) => ({
      factId: item.factId,
      durable: true as const,
    }));
    const relay = new SessionOutboxRelay({
      database,
      notificationConnectionString: f.url,
      pollIntervalMs: 20,
      bus: {
        checkHealth: async () => {},
        append,
      },
    });
    try {
      const seal = await request(f);
      blocker = f.database.transaction().execute(async (tx) => {
        await sql`set local idle_in_transaction_session_timeout='10s'`.execute(tx);
        await sql`lock table outbox in access exclusive mode`.execute(tx);
        locked.resolve();
        await release.promise;
      });
      await locked.promise;
      relay.start();
      await vi.waitFor(async () => {
        const { rows } = await sql<{
          n: number;
        }>`select count(*)::int n from pg_stat_activity where datname=${new URL(f.url).pathname.slice(1)} and wait_event_type='Lock' and query like '%with selected%'`.execute(
          f.database,
        );
        expect(rows[0]!.n).toBeGreaterThan(0);
      });
      closing = relay.close().then(() => {
        closed = true;
      });
      expect(() => relay.checkHealth()).toThrow();
      await vi.waitFor(() => expect(closed).toBe(true), { timeout: 2000 });
      expect(append).not.toHaveBeenCalled();
      release.resolve();
      await blocker;
      const row = await f.database
        .selectFrom("outbox")
        .selectAll()
        .where("id", "=", seal.factId)
        .executeTakeFirstOrThrow();
      expect(row.published_at).toBeNull();
      expect(row.attempts).toBe(0);
      await expect(sql`select 1`.execute(database)).resolves.toBeDefined();
    } finally {
      release.resolve();
      await blocker;
      await closing;
      await relay.close();
      await database.destroy();
      await f.close();
    }
  },
);

it.skipIf(!process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL)(
  "joins old authorization before retrying for the current ownership generation",
  async () => {
    const f = await nativeSubagentFixture(),
      entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const old = { partition: 0, generation: Symbol("old") },
      next = { partition: 0, generation: Symbol("next") };
    let owner = old,
      held = true;
    let pending: Promise<unknown> | undefined, second: Promise<unknown> | undefined;
    const db = f.database.withPlugin({
      transformQuery: ({ node }) => node,
      async transformResult({ result }) {
        if (held) {
          held = false;
          entered.resolve();
          await release.promise;
        }
        return result;
      },
    });
    const writer = vi.fn<PostgresPublicationControl["options"]["writer"]>(
      (_owner, _fact, authorize: () => Promise<void>) =>
        ({
          start: async () => {
            await authorize();
            await authorize();
          },
          append: async (item: { factId: string }) => ({ factId: item.factId, durable: true }),
          close: async () => {},
        }) as unknown as KafkaSessionWriter,
    );
    const control = new PostgresPublicationControl({
      database: db,
      current: (candidate) => candidate === owner,
      beforeSeal: async () => {},
      writer,
    });
    try {
      const seal = await request(f);
      pending = control.seal(old, seal);
      void pending.catch(() => {});
      await entered.promise;
      expect(control.seal(old, seal)).toBe(pending);
      owner = next;
      second = control.seal(next, seal);
      void second.catch(() => {});
      expect(second).not.toBe(pending);
      await expect(control.seal(old, seal)).rejects.toMatchObject({ reason: "not_owner" });
      expect(writer).not.toHaveBeenCalled();
      // PG is responsive; only the old call's result is held by this schedule.
      await sql`select 1`.execute(f.database);
      release.resolve();
      await expect(second).resolves.toMatchObject({ factId: seal.factId, durable: true });
      await expect(pending).rejects.toMatchObject({ reason: "not_owner" });
      expect(writer).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
      await Promise.allSettled([pending, second]);
      await control.close();
      await f.close();
    }
  },
);

it.skipIf(!process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL)(
  "measures an unbound Session seal from Outbox claim through publication receipt",
  async () => {
    const f = await nativeSubagentFixture(),
      owner = { partition: 0, generation: Symbol("owner") };
    const bindings = new PostgresSandboxBindings(
      f.database,
      "sandbox-domain-native-fixture",
      randomUUID(),
      "http://fixture.invalid",
      async (ids) => {
        expect(ids).toEqual([]);
      },
    );
    const phases: string[] = [],
      queries: string[] = [];
    let control: PostgresPublicationControl | undefined;
    try {
      await request(f);
      // The fixture also enqueues bootstrap control references. Model their
      // already-published state so this trace isolates one requested seal.
      await f.database
        .updateTable("outbox")
        .set({ published_at: new Date() })
        .where("aggregate_type", "=", "session_control_change")
        .execute();
      control = new PostgresPublicationControl({
        database: f.database,
        current: () => true,
        beforeSeal: async (seal) => {
          phases.push("close-routing");
          await bindings.closeWriter(seal.scope, true);
        },
        writer: (_owner, _fact, authorize) =>
          ({
            start: async () => {
              await authorize();
              phases.push("initialize");
              await authorize();
            },
            append: async (item: { factId: string }) => {
              phases.push("commit");
              return { factId: item.factId, durable: true };
            },
            close: async () => {
              phases.push("dispose");
            },
          }) as unknown as KafkaSessionWriter,
      });
      const relay = new SessionOutboxRelay({
        database: f.database,
        notificationConnectionString: f.url,
        bus: {
          checkHealth: async () => {},
          append: (seal) => {
            if (seal.kind !== "execution_seal") throw new Error("Unexpected fixture control");
            return control!.seal(owner, seal);
          },
        },
      });
      const original = Client.prototype.query;
      const spy = vi.spyOn(Client.prototype, "query").mockImplementation(function (
        this: Client,
        ...args: unknown[]
      ) {
        const q = args[0];
        queries.push(typeof q === "string" ? q : (q as { text: string }).text);
        return Reflect.apply(original, this, args);
      } as typeof original);
      try {
        expect(await relay.dispatchOne()).toBe(true);
      } finally {
        spy.mockRestore();
      }
      expect(queries).toHaveLength(6);
      expect(phases).toEqual(["close-routing", "initialize", "commit", "dispose"]);
      process.stdout.write(
        JSON.stringify({
          probe: "seal-sql",
          statements: queries.length,
          bindings: 0,
          authorityReads: queries.filter((q) => q.includes('from "outbox" as "o"')).length,
        }) + "\n",
      );
      await relay.close();
    } finally {
      await control?.close();
      await f.close();
    }
  },
);

it.skipIf(!process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL).each(["authority", "binding"] as const)(
  "bounds locked %s work before Kafka initialization",
  async (stage) => {
    const f = await nativeSubagentFixture();
    const database = createDatabase({
      connectionString: f.url,
      maxConnections: 2,
      checkoutTimeoutMs: 250,
    });
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const owner = { partition: 0, generation: Symbol("owner") };
    const writer = vi.fn<PostgresPublicationControl["options"]["writer"]>(() => {
      throw new Error("No producer may initialize before authority and binding closure");
    });
    const publish = vi.fn(async () => {});
    const bindings = new PostgresSandboxBindings(
      database,
      "fixture",
      randomUUID(),
      "http://unused",
      publish,
    );
    const control = new PostgresPublicationControl({
      database,
      current: () => true,
      writer,
      beforeSeal: (seal) => bindings.closeWriter(seal.scope, true),
    });
    let blocker: Promise<void> | undefined;
    try {
      const seal = await request(f);
      blocker = f.database.transaction().execute(async (tx) => {
        await sql`set local idle_in_transaction_session_timeout='10s'`.execute(tx);
        const table = stage === "authority" ? "outbox" : "sandbox_tool_bindings";
        await sql`lock table ${sql.table(table)} in access exclusive mode`.execute(tx);
        entered.resolve();
        await release.promise;
      });
      await entered.promise;
      const started = performance.now();
      await expect(control.seal(owner, seal)).rejects.toBeInstanceOf(Error);
      await control.close();
      expect(performance.now() - started).toBeLessThan(2000);
      expect(writer).not.toHaveBeenCalled();
      expect(publish).not.toHaveBeenCalled();
      release.resolve();
      await blocker;
      const row = await f.database
        .selectFrom("outbox")
        .select("published_at")
        .where("id", "=", seal.factId)
        .executeTakeFirstOrThrow();
      expect(row.published_at).toBeNull();
      await expect(sql`select 1`.execute(database)).resolves.toBeDefined();
    } finally {
      release.resolve();
      await blocker;
      await control.close();
      await database.destroy();
      await f.close();
    }
  },
);

it.skipIf(!process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL)(
  "drains the old writer before a new ownership generation initializes",
  async () => {
    const f = await nativeSubagentFixture();
    const old = { partition: 0, generation: Symbol("old") },
      next = { partition: 0, generation: Symbol("new") };
    let owner = old;
    const appendEntered = Promise.withResolvers<void>(),
      appendRelease = Promise.withResolvers<void>(),
      closeEntered = Promise.withResolvers<void>(),
      closeRelease = Promise.withResolvers<void>();
    const writer = vi.fn<PostgresPublicationControl["options"]["writer"]>(
      (generation, _fact, authorize) =>
        ({
          start: async () => {
            await authorize();
            await authorize();
          },
          append: async (item: { factId: string }) => {
            if (generation === old) {
              appendEntered.resolve();
              await appendRelease.promise;
              throw new Error("Old publication failed");
            }
            return { factId: item.factId, durable: true };
          },
          close: async () => {
            if (generation === old) {
              closeEntered.resolve();
              await closeRelease.promise;
            }
          },
        }) as unknown as KafkaSessionWriter,
    );
    const control = new PostgresPublicationControl({
      database: f.database,
      current: (value) => value === owner,
      beforeSeal: async () => {},
      writer,
    });
    let pending: Promise<unknown> | undefined, replacement: Promise<unknown> | undefined;
    try {
      const seal = await request(f);
      pending = control.seal(old, seal);
      void pending.catch(() => {});
      await appendEntered.promise;
      owner = next;
      replacement = control.seal(next, seal);
      void replacement.catch(() => {});
      appendRelease.resolve();
      await closeEntered.promise;
      expect(writer).toHaveBeenCalledTimes(1);
      closeRelease.resolve();
      await expect(pending).rejects.toThrow("Old publication failed");
      await expect(replacement).resolves.toMatchObject({ factId: seal.factId, durable: true });
      expect(writer).toHaveBeenCalledTimes(2);
    } finally {
      appendRelease.resolve();
      closeRelease.resolve();
      await Promise.allSettled([pending, replacement]);
      await control.close();
      await f.close();
    }
  },
);

it("does not evict a newer owner after a delayed failure from the old peer", async () => {
  const slow = { ...fact(), factId: randomUUID() },
    entered = Promise.withResolvers<void>();
  let target = "",
    routerCalls = 0,
    warm = true;
  let oldReply: import("node:http").ServerResponse | undefined;
  const old = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader("content-type", "application/json");
    if (body.factId === slow.factId) {
      oldReply = res;
      entered.resolve();
    } else if (warm) {
      warm = false;
      res.end(JSON.stringify({ factId: body.factId, durable: true }));
    } else {
      res.writeHead(409);
      res.end(JSON.stringify({ error: { code: "publication_not_sent", reason: "not_owner" } }));
    }
  });
  const current = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ factId: body.factId, durable: true }));
  });
  const router = createServer((_req, res) => {
    routerCalls++;
    res.writeHead(307, { location: target + PUBLICATION_PATH + "/seal" });
    res.end();
  });
  let client: HttpPublicationClient | undefined, delayed: Promise<unknown> | undefined;
  try {
    target = await listen(old);
    const next = await listen(current),
      base = await listen(router);
    client = new HttpPublicationClient({ baseUrl: base, token: "test-only", timeoutMs: 2000 });
    await client.publishSeal({ ...slow, factId: randomUUID() });
    delayed = client.publishSeal(slow);
    void delayed.catch(() => {});
    await entered.promise;
    target = next;
    await client.publishSeal({ ...slow, factId: randomUUID() });
    expect(routerCalls).toBe(2);
    oldReply!.destroy();
    await expect(delayed).rejects.toThrow();
    await client.publishSeal({ ...slow, factId: randomUUID() });
    expect(routerCalls).toBe(2);
  } finally {
    oldReply?.destroy();
    await client?.close();
    await Promise.allSettled([delayed, close(router), close(old), close(current)]);
  }
});

it.skipIf(!process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL)(
  "leaves a late successful claim for retry instead of admitting it after stop",
  async () => {
    const f = await nativeSubagentFixture();
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let hold = true;
    const database = f.database.withPlugin({
      transformQuery: ({ node }) => node,
      async transformResult({ result }) {
        if (hold) {
          hold = false;
          entered.resolve();
          await release.promise;
        }
        return result;
      },
    });
    const append = vi.fn(async (item: { factId: string }) => ({
      factId: item.factId,
      durable: true as const,
    }));
    const bus = { append, checkHealth: async () => {} };
    const relay = new SessionOutboxRelay({ database, notificationConnectionString: f.url, bus });
    let closing: Promise<void> | undefined;
    try {
      const seal = await request(f);
      await f.database
        .updateTable("outbox")
        .set({ published_at: new Date() })
        .where("aggregate_type", "=", "session_control_change")
        .execute();
      relay.start();
      await entered.promise;
      closing = relay.close();
      expect(() => relay.checkHealth()).toThrow();
      release.resolve();
      await closing;
      expect(append).not.toHaveBeenCalled();
      const row = await f.database
        .selectFrom("outbox")
        .select(["attempts", "published_at"])
        .where("id", "=", seal.factId)
        .executeTakeFirstOrThrow();
      expect(row).toMatchObject({ attempts: 1, published_at: null });
      await f.database
        .updateTable("outbox")
        .set({ available_at: new Date(0) })
        .where("id", "=", seal.factId)
        .execute();
      const next = new SessionOutboxRelay({
        database: f.database,
        notificationConnectionString: f.url,
        bus,
      });
      try {
        await next.dispatchOne();
      } finally {
        await next.close();
      }
      expect(append).toHaveBeenCalledOnce();
      expect(append).toHaveBeenCalledWith(expect.objectContaining({ factId: seal.factId }));
    } finally {
      release.resolve();
      await closing;
      await relay.close();
      await f.close();
    }
  },
);
