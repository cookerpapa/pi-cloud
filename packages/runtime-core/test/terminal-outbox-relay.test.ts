import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { sql } from "kysely";
import {
  SESSION_TERMINAL_EVENT_OUTBOX_TOPIC,
  SESSION_CONTROL_OUTBOX_TOPIC,
} from "@pi-cloud/protocol";
import { expect, it, vi } from "vitest";
import { SessionOutboxRelay } from "../src/session-outbox-relay.ts";
import { createPrivateTenant } from "../../control-plane/src/tenant-administration.ts";
import { ControlPlaneStore } from "../../control-plane/src/control-plane-store.ts";
import type { SessionLogFact } from "../src/accepted-fact.ts";

it("claims bounded Session heads without holding a connection during delivery and retries stable Facts", async () => {
  const pg = await PGlite.create();
  const socket = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0 });
  await socket.start();
  const notificationConnectionString = `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`;
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
            closesWriter: true,
            factId: id,
            scope: {
              tenantId: tenant,
              sessionId,
              runId: crypto.randomUUID(),
              turnId,
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
      append: async (fact: SessionLogFact) => {
        delivered.push(fact.factId);
        if (fact.factId === a1) await hold;
        return { factId: fact.factId, durable: true as const };
      },
    };
    const first = new SessionOutboxRelay({
      database: db,
      notificationConnectionString,
      bus,
    });
    const second = new SessionOutboxRelay({
      database: db,
      notificationConnectionString,
      bus,
    });
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
      append: vi.fn(async (fact: SessionLogFact) => {
        if (fail) throw new Error("ACK lost");
        return { factId: fact.factId, durable: true as const };
      }),
    };
    const retry = new SessionOutboxRelay({
      database: db,
      notificationConnectionString,
      bus: retryBus,
    });
    await expect(retry.dispatchOne()).rejects.toThrow("Session control publication failed");
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
    const staleRelay = new SessionOutboxRelay({
      database: db,
      notificationConnectionString,
      bus: staleBus,
    });
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
    const aggregate = crypto.randomUUID(),
      controlIds: string[] = [];
    await db
      .insertInto("pi_sessions")
      .values({
        tenant_id: tenant,
        id: sessionA,
      })
      .execute();
    for (const version of [1, 2, 3]) {
      const id = crypto.randomUUID();
      controlIds.push(id);
      await db
        .insertInto("outbox")
        .values({
          id,
          tenant_id: tenant,
          aggregate_type: "session_control_change",
          aggregate_id: aggregate,
          topic: SESSION_CONTROL_OUTBOX_TOPIC,
          payload: {
            kind: "control_change",
            factId: id,
            scope: { tenantId: tenant, piSessionId: sessionA },
            entity: "subagent_state",
            entityId: aggregate,
            version: String(version),
            occurredAt: new Date().toISOString(),
          },
          published_at: version === 3 ? null : new Date(Date.now() - 600000),
          available_at: new Date(Date.now() + 600000),
          last_error: null,
        })
        .execute();
    }
    const sealsBefore = await db
      .selectFrom("outbox")
      .select("id")
      .where("topic", "=", SESSION_TERMINAL_EVENT_OUTBOX_TOPIC)
      .execute();
    await second.prunePublishedControls();
    const retained = await db
      .selectFrom("outbox")
      .select("id")
      .where("topic", "=", SESSION_CONTROL_OUTBOX_TOPIC)
      .execute();
    expect(retained.map((r) => r.id).sort()).toEqual(controlIds.slice(2).sort());
    await db
      .deleteFrom("pi_sessions")
      .where("tenant_id", "=", tenant)
      .where("id", "=", sessionA)
      .execute();
    await second.prunePublishedControls();
    expect(
      (
        await db
          .selectFrom("outbox")
          .select("id")
          .where("topic", "=", SESSION_CONTROL_OUTBOX_TOPIC)
          .execute()
      ).map((r) => r.id),
    ).toEqual(controlIds.slice(2));
    expect(
      await db
        .selectFrom("outbox")
        .select("id")
        .where("topic", "=", SESSION_TERMINAL_EVENT_OUTBOX_TOPIC)
        .execute(),
    ).toEqual(sealsBefore);
  } finally {
    release();
    await db.destroy();
    await socket.stop();
    await pg.close();
  }
}, 30000);

it.skipIf(!process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL)(
  "keeps send slots independent from a slow publication and a slow cleanup, then drains cleanup batches",
  async () => {
    const url = new URL(process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!);
    const admin = createDatabase({ connectionString: url.toString(), maxConnections: 1 });
    const name = `outbox_slots_${crypto.randomUUID().replaceAll("-", "")}`;
    await sql`create database ${sql.id(name)}`.execute(admin);
    url.pathname = `/${name}`;
    const endpoint = url.toString(),
      db = createDatabase({ connectionString: endpoint, maxConnections: 4 });
    const held = Promise.withResolvers<void>(),
      cleanupHeld = Promise.withResolvers<void>();
    let relay: SessionOutboxRelay | undefined;
    try {
      await runMigrations(db, "up");
      const tenant = crypto.randomUUID();
      await db.insertInto("tenants").values({ id: tenant, slug: "relay-slots" }).execute();
      const control = (id: string, published: boolean) => ({
        id,
        tenant_id: tenant,
        aggregate_type: "session_control_change",
        aggregate_id: id,
        topic: SESSION_CONTROL_OUTBOX_TOPIC,
        payload: {
          kind: "control_change",
          factId: id,
          scope: { tenantId: tenant, piSessionId: id },
          entity: "subagent_state",
          entityId: id,
          version: "1",
          occurredAt: new Date().toISOString(),
        },
        published_at: published ? new Date(Date.now() - 600000) : null,
        available_at: new Date(0),
        last_error: null,
      });
      const ids = Array.from({ length: 20 }, () => crypto.randomUUID());
      await db
        .insertInto("outbox")
        .values(
          ids.map((id, i) => ({
            ...control(id, false),
            created_at: new Date(Date.now() - 20000 + i),
          })),
        )
        .execute();
      const calls = new Map<string, number>();
      let concurrent = 0,
        maximum = 0;
      relay = new SessionOutboxRelay({
        database: db,
        notificationConnectionString: endpoint,
        claimLeaseMs: 150,
        bus: {
          checkHealth: async () => {},
          append: async (fact) => {
            calls.set(fact.factId, (calls.get(fact.factId) ?? 0) + 1);
            concurrent++;
            maximum = Math.max(maximum, concurrent);
            try {
              if (fact.factId === ids[0]) await held.promise;
              return { factId: fact.factId, durable: true };
            } finally {
              concurrent--;
            }
          },
        },
      });
      const prune = relay.prunePublishedControls.bind(relay);
      const cleanup = vi.spyOn(relay, "prunePublishedControls").mockImplementationOnce(async () => {
        await cleanupHeld.promise;
        return prune();
      });
      relay.start();
      await vi.waitFor(() => expect(calls.size).toBe(20), { timeout: 10000 });
      expect(maximum).toBeLessThanOrEqual(16);
      await vi.waitFor(() => expect(cleanup).toHaveBeenCalled(), { timeout: 5000 });
      const extra = crypto.randomUUID();
      await db.insertInto("outbox").values(control(extra, false)).execute();
      await vi.waitFor(() => expect(calls.has(extra)).toBe(true), { timeout: 5000 });
      expect(calls.get(ids[0]!)).toBe(1); // Its expired PG claim cannot occupy another local slot.
      const old = Array.from({ length: 1025 }, () => control(crypto.randomUUID(), true));
      await db.insertInto("outbox").values(old).execute();
      cleanupHeld.resolve();
      await vi.waitFor(
        async () =>
          expect(
            (
              await db
                .selectFrom("outbox")
                .select("id")
                .where(
                  "id",
                  "in",
                  old.map((row) => row.id),
                )
                .execute()
            ).length,
          ).toBe(0),
        { timeout: 10000 },
      );
      expect(calls.get(ids[0]!)).toBe(1);
    } finally {
      held.resolve();
      cleanupHeld.resolve();
      await relay?.close();
      await db.destroy();
      await sql`drop database ${sql.id(name)}`.execute(admin);
      await admin.destroy();
    }
  },
  30000,
);

it("retains the queue version head and every unpublished reference while pruning disposable control heads", async () => {
  const pg = await PGlite.create(),
    socket = new PGLiteSocketServer({ db: pg, host: "127.0.0.1", port: 0 });
  await socket.start();
  const endpoint = `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
    db = createDatabase({ connectionString: endpoint, maxConnections: 2 });
  try {
    await runMigrations(db, "up");
    const tenant = await createPrivateTenant(db, {
      slug: "queue-head",
      ownerDisplayName: "Queue head",
    });
    const store = new ControlPlaneStore({ database: db, ...tenant });
    const project = await store.createProject({ name: "Queue head", source: { kind: "empty" } });
    const session = await store.createSession(
      project.projectId,
      project.workspaceId,
      "Queue head",
      "elastic",
    );
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const result = await sql<{
        id: string;
      }>`select pi_cloud_control_change(${tenant.tenantId}::uuid,${session.sessionId},'input_queue',
        ${session.sessionId}::uuid,nextval('session_control_change_version'),'{}'::jsonb) id`.execute(
        db,
      );
      const id = result.rows[0]!.id;
      ids.push(id);
      if (i < 2)
        await db
          .updateTable("outbox")
          .set({ published_at: new Date(Date.now() - 600000) })
          .where("id", "=", id)
          .execute();
    }
    const relay = new SessionOutboxRelay({
      database: db,
      notificationConnectionString: endpoint,
      bus: { checkHealth: async () => {}, append: vi.fn() },
    });
    await relay.prunePublishedControls();
    const retained = () => db.selectFrom("outbox").select("id").where("id", "in", ids).execute();
    expect((await retained()).map((r) => r.id).sort()).toEqual(ids.slice(1).sort());
    await db.deleteFrom("sessions").where("id", "=", session.sessionId).execute();
    await relay.prunePublishedControls();
    expect((await retained()).map((r) => r.id)).toEqual(ids.slice(2));
    await relay.close();
  } finally {
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
  const relay = new SessionOutboxRelay({
    database: db,
    notificationConnectionString: `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`,
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
