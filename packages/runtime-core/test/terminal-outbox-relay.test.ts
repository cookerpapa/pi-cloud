import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { SESSION_TERMINAL_EVENT_OUTBOX_TOPIC } from "@pi-cloud/protocol";
import { expect, it, vi } from "vitest";
import { AcceptedFactTerminalOutboxRelay } from "../src/accepted-fact-terminal-outbox-relay.ts";
import type { AcceptedFact } from "../src/accepted-fact.ts";

it("claims bounded Session heads without holding a connection during delivery and retries stable Facts", async () => {
  const pg = await PGlite.create();
  const socket = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0 });
  await socket.start();
  const db = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 1,
  });
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await runMigrations(db, "up");
    const tenant = crypto.randomUUID(),
      sessionA = crypto.randomUUID(),
      sessionB = crypto.randomUUID();
    await db.insertInto("tenants").values({ id: tenant, slug: "outbox-claim-test" }).execute();
    const insert = async (sessionId: string, seq: number, order: number) => {
      const id = crypto.randomUUID(),
        turnId = crypto.randomUUID();
      const time = new Date(Date.now() - 10000 + order);
      await db
        .insertInto("outbox")
        .values({
          id,
          tenant_id: tenant,
          aggregate_type: "session_terminal_event",
          aggregate_id: id,
          topic: SESSION_TERMINAL_EVENT_OUTBOX_TOPIC,
          created_at: time,
          available_at: time,
          published_at: null,
          last_error: null,
          payload: {
            kind: "execution_seal",
            factId: id,
            scope: {
              tenantId: tenant,
              sessionId,
              runId: crypto.randomUUID(),
              turnId,
              attemptId: crypto.randomUUID(),
              fencingToken: 1,
            },
            occurredAt: time.toISOString(),
            baseSequence: seq - 1,
            agentId: "root",
            terminal: {
              schemaVersion: 1,
              eventId: id,
              sessionId,
              turnId,
              seq,
              agentId: "root",
              type: "turn.completed",
              occurredAt: time.toISOString(),
              payload: { stopReason: "stop" },
            },
          },
        })
        .execute();
      return id;
    };
    const a1 = await insert(sessionA, 2, 1),
      a2 = await insert(sessionA, 4, 2),
      b1 = await insert(sessionB, 2, 3);
    const delivered: string[] = [];
    const bus = {
      checkHealth: async () => {},
      append: async (fact: AcceptedFact) => {
        delivered.push(fact.factId);
        if (fact.factId === a1) await hold;
        return { factId: fact.factId, durable: true as const };
      },
    };
    const first = new AcceptedFactTerminalOutboxRelay({ database: db, bus });
    const second = new AcceptedFactTerminalOutboxRelay({ database: db, bus });
    const held = first.dispatchOne();
    await vi.waitFor(() => expect(delivered).toEqual([a1]));
    await expect(second.dispatchOne()).resolves.toBe(true);
    expect(delivered).toEqual([a1, b1]);
    await expect(second.dispatchOne()).resolves.toBe(false);
    release();
    await held;
    await second.dispatchOne();
    expect(delivered).toEqual([a1, b1, a2]);

    const retried = await insert(sessionB, 4, 4);
    let fail = true;
    const retryBus = {
      checkHealth: async () => {},
      append: vi.fn(async (fact: AcceptedFact) => {
        if (fail) throw new Error("ACK lost");
        return { factId: fact.factId, durable: true as const };
      }),
    };
    const retry = new AcceptedFactTerminalOutboxRelay({ database: db, bus: retryBus });
    await expect(retry.dispatchOne()).rejects.toThrow("Terminal publication failed");
    await db
      .updateTable("outbox")
      .set({ available_at: new Date(0) })
      .where("id", "=", retried)
      .execute();
    fail = false;
    await retry.dispatchOne();
    expect(retryBus.append.mock.calls.map(([fact]) => fact.factId)).toEqual([retried, retried]);
    expect(
      await db
        .selectFrom("outbox")
        .select(["attempts", "published_at"])
        .where("id", "=", retried)
        .executeTakeFirst(),
    ).toEqual({ attempts: 2, published_at: expect.any(Date) });

    const staleId = await insert(sessionB, 6, 5);
    let failStale!: (error: Error) => void;
    const stalled = new Promise<never>((_, reject) => {
      failStale = reject;
    });
    const staleBus = { checkHealth: async () => {}, append: vi.fn(async () => stalled) };
    const staleRelay = new AcceptedFactTerminalOutboxRelay({ database: db, bus: staleBus });
    const staleDispatch = staleRelay.dispatchOne().catch((error) => error);
    await vi.waitFor(() => expect(staleBus.append).toHaveBeenCalledOnce());
    await db
      .updateTable("outbox")
      .set({ available_at: new Date(0) })
      .where("id", "=", staleId)
      .execute();
    await second.dispatchOne();
    const fresh = await db
      .selectFrom("outbox")
      .select(["attempts", "published_at", "available_at", "last_error"])
      .where("id", "=", staleId)
      .executeTakeFirstOrThrow();
    failStale(new Error("late failed ACK from an expired claimant"));
    expect(await staleDispatch).toBeInstanceOf(AggregateError);
    expect(
      await db
        .selectFrom("outbox")
        .select(["attempts", "published_at", "available_at", "last_error"])
        .where("id", "=", staleId)
        .executeTakeFirstOrThrow(),
    ).toEqual(fresh);
  } finally {
    release();
    await db.destroy();
    await socket.stop();
    await pg.close();
  }
}, 30000);

it("recovers relay health after a transient PG error even when the Outbox is empty", async () => {
  const pg = await PGlite.create();
  const socket = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0 });
  await socket.start();
  const db = createDatabase({
    connectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    maxConnections: 1,
  });
  const append = vi.fn();
  const relay = new AcceptedFactTerminalOutboxRelay({
    database: db,
    bus: { checkHealth: async () => {}, append },
    pollIntervalMs: 10,
  });
  const execute = vi.spyOn(db.getExecutor(), "executeQuery");
  try {
    await runMigrations(db, "up");
    execute.mockClear();
    execute.mockRejectedValue(new Error("temporary PG connection failure"));
    relay.start();
    await vi.waitFor(() => {
      expect(execute).toHaveBeenCalled();
      expect(() => relay.checkHealth()).toThrow("unhealthy");
    });
    execute.mockRestore();
    await vi.waitFor(() => expect(() => relay.checkHealth()).not.toThrow());
    expect(append).not.toHaveBeenCalled();
  } finally {
    execute.mockRestore();
    await relay.close();
    await db.destroy();
    await socket.stop();
    await pg.close();
  }
}, 30000);
