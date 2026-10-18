// Review characterizations of current behavior. Disposable PG/HTTP only.
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Client } from "pg";
import { sql } from "kysely";
import { expect, it, vi } from "vitest";
import type { KafkaSessionWriter } from "@pi-cloud/event-log";
import { nativeSubagentFixture } from "../../../packages/control-plane/test/native-subagent-fixture.ts";
import { requestExecutionStreamSeal } from "../../../packages/runtime-core/src/execution-stream-seal.ts";
import { PostgresPublicationControl } from "../../../packages/runtime-core/src/postgres-publication-control.ts";
import { SessionOutboxRelay } from "../../../packages/runtime-core/src/session-outbox-relay.ts";
import {
  HttpPublicationClient,
  PUBLICATION_PATH,
} from "../../../packages/runtime-core/src/http-publication-client.ts";
import { PostgresSandboxBindings } from "../../../packages/sandbox-control/src/sandbox-bindings.ts";
import type { AcceptedExecutionSealFact } from "../../../packages/runtime-core/src/accepted-fact.ts";

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

it("retains an unreachable cached peer across retries despite working owner discovery", async () => {
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
    for (let i = 0; i < 3; i++) await expect(client.publishSeal(retry)).rejects.toThrow();
    expect(calls).toEqual({ router: 1, old: 1, current: 0 });
    const fresh = new HttpPublicationClient({
      baseUrl: base,
      token: "review-only",
      timeoutMs: 500,
    });
    clients.push(fresh);
    await expect(fresh.publishSeal(retry)).resolves.toMatchObject({
      durable: true,
    });
    expect(calls.current).toBe(1);
    process.stdout.write(
      JSON.stringify({
        probe: "stale-peer",
        failedRetries: 3,
        oldClientRediscovered: false,
        freshClientSucceeded: true,
      }) + "\n",
    );
  } finally {
    await Promise.allSettled(clients.map((c) => c.close()));
    await Promise.all([close(router), close(old), close(current)]);
  }
});

it.skipIf(!process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL)(
  "waits on PG after relay stop while health still reports ready",
  async () => {
    const f = await nativeSubagentFixture(),
      locked = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let blocker: Promise<void> | undefined,
      closing: Promise<void> | undefined,
      closed = false;
    const relay = new SessionOutboxRelay({
      database: f.database,
      notificationConnectionString: f.url,
      pollIntervalMs: 20,
      bus: {
        checkHealth: async () => {},
        append: async (item) => ({ factId: item.factId, durable: true }),
      },
    });
    try {
      await request(f);
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
      await new Promise((r) => setTimeout(r, 1250));
      expect(closed).toBe(false);
      expect(() => relay.checkHealth()).not.toThrow();
      process.stdout.write(
        JSON.stringify({
          probe: "relay-pg-wait",
          blockedAfterStopMsAtLeast: 1250,
          healthReportedReady: true,
        }) + "\n",
      );
    } finally {
      release.resolve();
      await blocker;
      await closing;
      await relay.close();
      await f.close();
    }
  },
);

it.skipIf(!process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL)(
  "coalesces a new partition owner onto the old owner's stalled authorization",
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
      owner = next;
      second = control.seal(next, seal);
      void second.catch(() => {});
      expect(second).toBe(pending);
      expect(writer).not.toHaveBeenCalled();
      // PG is responsive; only the old call's result is held by this schedule.
      await sql`select 1`.execute(f.database);
      release.resolve();
      await expect(second).rejects.toMatchObject({ reason: "not_owner" });
      await expect(control.seal(next, seal)).resolves.toMatchObject({ durable: true });
      expect(writer).toHaveBeenCalledOnce();
      process.stdout.write(
        JSON.stringify({
          probe: "owner-generation-coalescing",
          newOwnerBorrowedOldPromise: true,
          firstNewOwnerCallRejected: true,
          freshRetrySucceeded: true,
        }) + "\n",
      );
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
