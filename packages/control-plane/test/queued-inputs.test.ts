import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { Pool } from "pg";
import { sql, type Kysely, type QueryId } from "kysely";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { MAX_QUEUED_INPUTS } from "@pi-cloud/protocol";
import { parseKafkaAcceptedFact } from "@pi-cloud/runtime-core/kafka-accepted-fact";
import { projectNativeSessionAppend } from "@pi-cloud/pi-session-postgres";
import { ExecutionStreamProjector } from "@pi-cloud/runtime-core";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { QueuedInputService } from "../src/queued-input-service.ts";
import { TurnSteeringService } from "../src/turn-steering-service.ts";
import { TurnSteerBackendError, type TurnSteerRequest } from "../src/turn-steer.ts";
import { createTestWorker } from "./admit-test-execution.ts";

const external = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
describe.sequential("pending conversation inputs", () => {
  let database: Kysely<Database>,
    engine: PGlite | undefined,
    socket: PGLiteSocketServer | undefined;
  let admin: Pool | undefined, name: string, url: string;
  let offset = 0n;
  beforeAll(async () => {
    if (external) {
      admin = new Pool({ connectionString: external, max: 1 });
      name = `queue_inputs_${randomUUID().replaceAll("-", "")}`;
      await admin.query(`create database "${name}"`);
      const endpoint = new URL(external);
      endpoint.pathname = `/${name}`;
      endpoint.searchParams.set("options", "-c lock_timeout=1000 -c statement_timeout=5000");
      url = endpoint.toString();
    } else {
      engine = await PGlite.create();
      socket = new PGLiteSocketServer({ db: engine, host: "127.0.0.1", port: 0 });
      await socket.start();
      url = `postgresql://postgres@${socket.getServerConn()}/postgres?sslmode=disable`;
    }
    database = createDatabase({ connectionString: url, maxConnections: external ? 8 : 1 });
    await runMigrations(database, "up");
  }, 60000);
  afterAll(async () => {
    await database?.destroy();
    await socket?.stop();
    await engine?.close();
    if (admin) {
      await admin.query(`drop database "${name}"`);
      await admin.end();
    }
  });

  async function fixture(deliver: (request: TurnSteerRequest) => Promise<void> = async () => {}) {
    const tenant = await createPrivateTenant(database, {
      slug: `q-${randomUUID()}`,
      ownerDisplayName: "Queue fixture",
    });
    const store = new ControlPlaneStore({ database, ...tenant });
    const project = await store.createProject({ name: "queue", source: { kind: "empty" } });
    const session = await store.createSession(
      project.projectId,
      project.workspaceId,
      "Queue",
      "elastic",
    );
    const steering = new TurnSteeringService({
      database,
      backendFactory: async () => ({ steer: deliver }),
    });
    const queue = new QueuedInputService({ database, steering });
    const list = () => queue.list(tenant.tenantId, session.sessionId);
    const accept = (text: string, key: string = randomUUID()) =>
      store.acceptTurn(session.sessionId, key, { prompt: text });
    return { tenant, store, session, queue, steering, list, accept };
  }
  async function seal(runId: string) {
    const outbox = await database
      .selectFrom("outbox")
      .select("payload")
      .where(sql<boolean>`payload#>>'{scope,runId}'=${runId}`)
      .executeTakeFirstOrThrow();
    await new ExecutionStreamProjector(database).project({
      fact: parseKafkaAcceptedFact(JSON.stringify(outbox.payload)),
      topic: "queue-input-tests",
      partition: 0,
      offset: offset++,
    });
  }
  async function active(f: Awaited<ReturnType<typeof fixture>>) {
    const first = await f.accept("active task");
    const source = await f.accept("queued instruction");
    const entered = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>();
    const worker = await createTestWorker(database);
    const execution = worker
      .executor({
        execute: async () => {
          entered.resolve();
          await finish.promise;
          return { stopReason: "stop" };
        },
      })
      .dispatchRun(first.runId);
    void execution.catch((error) => entered.reject(error));
    await entered.promise;
    return { first, source, worker, finish, execution };
  }
  async function recordInput(request: TurnSteerRequest) {
    const s = await database
      .selectFrom("sessions")
      .select("pi_session_id")
      .where("id", "=", request.target.sessionId)
      .executeTakeFirstOrThrow();
    const next = await database
      .selectFrom("pi_sessions")
      .select("next_seq")
      .where("id", "=", s.pi_session_id)
      .executeTakeFirstOrThrow();
    const lane = await database
      .selectFrom("pi_session_lanes")
      .select("leaf_id")
      .where("session_id", "=", s.pi_session_id)
      .where("lane", "=", "main")
      .executeTakeFirstOrThrow();
    await database.transaction().execute((tx) =>
      projectNativeSessionAppend(tx, {
        tenantId: request.target.tenantId,
        sessionId: s.pi_session_id,
        appendId: randomUUID(),
        items: [
          {
            kind: "entry",
            lane: "main",
            turnId: request.target.turnId,
            entry: {
              id: `pc-agent-input-${request.controlRequestId}`,
              type: "message",
              parentId: lane.leaf_id,
              seq: Number(next.next_seq),
              timestamp: Date.now(),
              message: {
                role: "user",
                content: [{ type: "text", text: request.text }],
                timestamp: Date.now(),
              },
            },
          },
        ],
      }),
    );
  }

  it("edits, reorders and cancels pending inputs without changing original acceptance identity", async () => {
    const f = await fixture();
    const a = await f.accept("A"),
      b = await f.accept("B", "original-b"),
      c = await f.accept("C");
    let q = await f.list();
    const before = q.revision;
    const edit = { action: "edit" as const, revision: q.revision, text: "B revised" };
    q = (await f.queue.mutate(f.tenant.tenantId, f.session.sessionId, b.turnId, "edit-b", edit))
      .queue;
    await expect(
      f.queue.mutate(f.tenant.tenantId, f.session.sessionId, c.turnId, "stale", {
        action: "edit",
        revision: before,
        text: "lost edit",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(
      (await f.queue.mutate(f.tenant.tenantId, f.session.sessionId, b.turnId, "edit-b", edit))
        .replayed,
    ).toBe(true);
    expect((await f.accept("B", "original-b")).runId).toBe(b.runId);
    expect((await f.list()).items.find((i) => i.turnId === b.turnId)?.text).toBe("B revised");
    const move = { action: "move" as const, revision: q.revision, direction: "up" as const };
    q = (await f.queue.mutate(f.tenant.tenantId, f.session.sessionId, c.turnId, "move-c", move))
      .queue;
    expect(q.items.map((i) => i.text)).toEqual(["A", "C", "B revised"]);
    expect(
      (
        await f.queue.mutate(f.tenant.tenantId, f.session.sessionId, c.turnId, "move-c", move)
      ).queue.items.map((i) => i.text),
    ).toEqual(["A", "C", "B revised"]);
    q = (
      await f.queue.mutate(f.tenant.tenantId, f.session.sessionId, a.turnId, "move-a", {
        action: "move",
        revision: q.revision,
        direction: "down",
      })
    ).queue;
    expect(q.items.map((i) => i.text)).toEqual(["C", "A", "B revised"]);
    q = (
      await f.queue.mutate(f.tenant.tenantId, f.session.sessionId, c.turnId, "cancel-c", {
        action: "cancel",
        revision: q.revision,
      })
    ).queue;
    expect(q.items.map((i) => i.text)).toEqual(["A", "B revised"]);
    expect(
      await database
        .selectFrom("runs")
        .select(["state", "lease_id", "started_at", "output_seal_id"])
        .where("id", "=", c.runId)
        .executeTakeFirst(),
    ).toEqual({ state: "cancelled", lease_id: null, started_at: null, output_seal_id: null });
    expect(
      (await f.store.getConversation(f.session.sessionId)).turns.some((t) => t.turnId === c.turnId),
    ).toBe(false);
  });

  it("freezes edited input at admission and preserves queue order after cancelling its head", async () => {
    const f = await fixture();
    const a = await f.accept("remove"),
      b = await f.accept("old");
    let q = await f.list();
    q = (
      await f.queue.mutate(f.tenant.tenantId, f.session.sessionId, b.turnId, "edit", {
        action: "edit",
        revision: q.revision,
        text: "new",
      })
    ).queue;
    await f.queue.mutate(f.tenant.tenantId, f.session.sessionId, a.turnId, "cancel", {
      action: "cancel",
      revision: q.revision,
    });
    const worker = await createTestWorker(database);
    const received: string[] = [];
    expect(
      await worker
        .executor({
          execute: async (r) => {
            received.push(r.input.prompt);
            return { stopReason: "stop" };
          },
        })
        .dispatchRun(b.runId),
    ).toMatchObject({ status: "completed" });
    expect(received).toEqual(["new"]);
    q = await f.list();
    await expect(
      f.queue.mutate(f.tenant.tenantId, f.session.sessionId, b.turnId, "too-late", {
        action: "edit",
        revision: q.revision,
        text: "rewrite",
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    await seal(b.runId);
  });

  it("checks tenant scope, immutable idempotency requests and queue bounds", async () => {
    const f = await fixture();
    const a = await f.accept("A");
    let q = await f.list();
    await expect(f.queue.list(randomUUID(), f.session.sessionId)).rejects.toMatchObject({
      code: "not_found",
    });
    await expect(
      f.queue.mutate(randomUUID(), f.session.sessionId, a.turnId, "foreign", {
        action: "cancel",
        revision: q.revision,
      }),
    ).rejects.toMatchObject({ code: "not_found" });
    await f.queue.mutate(f.tenant.tenantId, f.session.sessionId, a.turnId, "edit", {
      action: "edit",
      revision: q.revision,
      text: "new",
    });
    await expect(
      f.queue.mutate(f.tenant.tenantId, f.session.sessionId, a.turnId, "edit", {
        action: "cancel",
        revision: q.revision,
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    for (let i = 1; i < MAX_QUEUED_INPUTS; i++) await f.accept(`input ${i}`);
    await expect(f.accept("overflow")).rejects.toMatchObject({ code: "conflict" });
    expect((await f.list()).items).toHaveLength(MAX_QUEUED_INPUTS);
  }, 30000);

  it("recovers a consumed promotion after a lost reply and API restart without duplicate delivery", async () => {
    let deliveries = 0;
    const f = await fixture(async (request) => {
      deliveries++;
      expect(request.text).toBe("edited steer");
      await recordInput(request);
      throw new TurnSteerBackendError("reply_lost", "lost", true, true);
    });
    const run = await active(f);
    try {
      const q = await f.list();
      const result = await f.queue.mutate(
        f.tenant.tenantId,
        f.session.sessionId,
        run.source.turnId,
        "promote",
        {
          action: "steer",
          revision: q.revision,
          targetTurnId: run.first.turnId,
          text: "edited steer",
        },
      );
      expect(result.queue.items).toMatchObject([{ status: "steering" }]);
      expect(
        await run.worker
          .executor({
            execute: async () => {
              throw new Error("Held source cannot execute");
            },
          })
          .dispatchRun(run.source.runId),
      ).toEqual({ status: "idle" });
      await f.queue.reconcileOnce();
      const restarted = new QueuedInputService({ database, steering: f.steering });
      await restarted.reconcileOnce();
      expect(deliveries).toBe(1);
      expect((await f.list()).items).toEqual([]);
      expect(
        await database
          .selectFrom("runs")
          .select(["state", "started_at"])
          .where("id", "=", run.source.runId)
          .executeTakeFirst(),
      ).toEqual({ state: "cancelled", started_at: null });
    } finally {
      run.finish.resolve();
      await run.execution;
      await seal(run.first.runId);
    }
  });

  it.each([false, true])(
    "restores unconsumed promotion only after the target seal (reply lost=%s)",
    async (lost) => {
      let deliveries = 0;
      const f = await fixture(async () => {
        deliveries++;
        if (lost) throw new TurnSteerBackendError("reply_lost", "lost", true, true);
      });
      const run = await active(f);
      try {
        const q = await f.list();
        await f.queue.mutate(f.tenant.tenantId, f.session.sessionId, run.source.turnId, "promote", {
          action: "steer",
          revision: q.revision,
          targetTurnId: run.first.turnId,
        });
        await f.queue.reconcileOnce();
        expect((await f.list()).items[0]?.status).toBe("steering");
        run.finish.resolve();
        await run.execution;
        await f.queue.reconcileOnce();
        expect((await f.list()).items[0]?.status).toBe("steering");
        await seal(run.first.runId);
        const restarted = new QueuedInputService({ database, steering: f.steering });
        await restarted.reconcileOnce();
        expect((await f.list()).items).toMatchObject([
          { status: "queued", text: "queued instruction" },
        ]);
        expect(deliveries).toBe(1);
        const received: string[] = [];
        expect(
          await run.worker
            .executor({
              execute: async (r) => {
                received.push(r.input.prompt);
                return { stopReason: "stop" };
              },
            })
            .dispatchRun(run.source.runId),
        ).toMatchObject({ status: "completed" });
        expect(received).toEqual(["queued instruction"]);
        await seal(run.source.runId);
      } finally {
        run.finish.resolve();
        await run.execution;
      }
    },
  );

  it.skipIf(!external).each(["edit", "cancel", "move"] as const)(
    "rejects %s when Worker admission holds the affected Run without deadlocking",
    async (action) => {
      const f = await fixture();
      const accepted = await f.accept("original");
      const neighbor = await f.accept("neighbor");
      const q = await f.list();
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const targets = new Set<QueryId>();
      const observed = database.withPlugin({
        transformQuery({ node, queryId }) {
          if (
            database
              .getExecutor()
              .compileQuery(node, queryId)
              .sql.startsWith('with "claim_candidate"')
          )
            targets.add(queryId);
          return node;
        },
        async transformResult({ result, queryId }) {
          if (targets.has(queryId)) {
            entered.resolve();
            await release.promise;
          }
          return result;
        },
      });
      const worker = await createTestWorker(database);
      const received: string[] = [];
      const running = worker
        .executor(
          {
            execute: async (r) => {
              received.push(r.input.prompt);
              return { stopReason: "stop" };
            },
          },
          { database: observed },
        )
        .dispatchRun(accepted.runId);
      void running.catch((error) => entered.reject(error));
      try {
        await entered.promise;
        await expect(
          f.queue.mutate(
            f.tenant.tenantId,
            f.session.sessionId,
            action === "move" ? neighbor.turnId : accepted.turnId,
            "racing",
            action === "edit"
              ? { action: "edit", revision: q.revision, text: "too late" }
              : action === "move"
                ? { action: "move", revision: q.revision, direction: "up" }
                : { action: "cancel", revision: q.revision },
          ),
        ).rejects.toMatchObject({ code: "conflict" });
      } finally {
        release.resolve();
      }
      expect(await running).toMatchObject({ status: "completed" });
      expect(received).toEqual(["original"]);
      await seal(accepted.runId);
    },
  );

  it("executes the reordered head first and keeps pending inputs out of history pages", async () => {
    const f = await fixture();
    const a = await f.accept("A"),
      b = await f.accept("B");
    let q = await f.list();
    await f.queue.mutate(f.tenant.tenantId, f.session.sessionId, b.turnId, "up", {
      action: "move",
      revision: q.revision,
      direction: "up",
    });
    expect((await f.store.getConversation(f.session.sessionId)).turns).toEqual([]);
    const worker = await createTestWorker(database),
      received: string[] = [];
    const executor = worker.executor({
      execute: async (r) => {
        received.push(r.input.prompt);
        return { stopReason: "stop" };
      },
    });
    expect(await executor.dispatchRun(a.runId)).toEqual({ status: "idle" });
    expect(await executor.dispatchRun(b.runId)).toMatchObject({ status: "completed" });
    await seal(b.runId);
    expect(await executor.dispatchRun(a.runId)).toMatchObject({ status: "completed" });
    await seal(a.runId);
    expect(received).toEqual(["B", "A"]);
    for (let i = 0; i < 45; i++) await f.accept(`pending ${i}`);
    const history = await f.store.getConversation(f.session.sessionId);
    expect(history.turns.map((t) => t.turnId)).toEqual([b.turnId, a.turnId]);
    expect(history.historyTruncated).toBe(false);
    expect((await f.list()).items).toHaveLength(45);
  });

  it.skipIf(!external)(
    "deduplicates concurrent replicas and rejects a competing stale queue mutation",
    async () => {
      const f = await fixture(),
        input = await f.accept("original");
      const other = new QueuedInputService({ database, steering: f.steering });
      let q = await f.list();
      const action = { action: "edit" as const, revision: q.revision, text: "shared edit" };
      const results = await Promise.all(
        [f.queue, other].map((service) =>
          service.mutate(f.tenant.tenantId, f.session.sessionId, input.turnId, "same", action),
        ),
      );
      expect(results.map((r) => r.replayed).sort()).toEqual([false, true]);
      q = await f.list();
      const races = await Promise.allSettled([
        f.queue.mutate(f.tenant.tenantId, f.session.sessionId, input.turnId, "edit-again", {
          action: "edit",
          revision: q.revision,
          text: "winner",
        }),
        other.mutate(f.tenant.tenantId, f.session.sessionId, input.turnId, "remove", {
          action: "cancel",
          revision: q.revision,
        }),
      ]);
      expect(races.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(races.filter((r) => r.status === "rejected")).toMatchObject([
        { reason: { code: "conflict" } },
      ]);
    },
  );

  it("orders promotions to one Run across API replicas while an earlier reply is pending", async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const observed: string[] = [];
    const f = await fixture(async (request) => {
      observed.push(request.text);
      if (observed.length === 1) {
        entered.resolve();
        await release.promise;
      }
    });
    const run = await active(f);
    let delivering: Promise<void> | undefined;
    try {
      const later = await f.accept("second promotion");
      let q = await f.list();
      await f.queue.mutate(
        f.tenant.tenantId,
        f.session.sessionId,
        run.source.turnId,
        "first-promotion",
        { action: "steer", revision: q.revision, targetTurnId: run.first.turnId },
      );
      q = await f.list();
      await f.queue.mutate(
        f.tenant.tenantId,
        f.session.sessionId,
        later.turnId,
        "second-promotion",
        { action: "steer", revision: q.revision, targetTurnId: run.first.turnId },
      );
      delivering = f.queue.reconcileOnce();
      await entered.promise;
      const other = new QueuedInputService({ database, steering: f.steering });
      await other.reconcileOnce();
      expect(observed).toEqual(["queued instruction"]);
      release.resolve();
      await delivering;
      await other.reconcileOnce();
      expect(observed).toEqual(["queued instruction", "second promotion"]);
    } finally {
      release.resolve();
      await delivering;
      run.finish.resolve();
      await run.execution;
      await seal(run.first.runId);
      await f.queue.reconcileOnce();
    }
  });

  it("stops new promotion deliveries during shutdown and resumes persisted work after restart", async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let calls = 0;
    const fixtures: Awaited<ReturnType<typeof fixture>>[] = [];
    const executions: Awaited<ReturnType<typeof active>>[] = [];
    let service: QueuedInputService | undefined;
    try {
      for (let i = 0; i < 3; i++) {
        const f = await fixture(async () => {
          if (++calls === 2) entered.resolve();
          await release.promise;
        });
        fixtures.push(f);
        const run = await active(f);
        executions.push(run);
        const q = await f.list();
        await f.queue.mutate(f.tenant.tenantId, f.session.sessionId, run.source.turnId, "promote", {
          action: "steer",
          revision: q.revision,
          targetTurnId: run.first.turnId,
        });
      }
      service = new QueuedInputService({
        database,
        steering: fixtures[0]!.steering,
        autoStart: true,
      });
      service.onModuleInit();
      await entered.promise;
      let stopped = false;
      const stop = service.onApplicationShutdown().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      release.resolve();
      await stop;
      expect(calls).toBe(2);
      const restarted = new QueuedInputService({ database, steering: fixtures[0]!.steering });
      await restarted.reconcileOnce();
      expect(calls).toBe(3);
    } finally {
      release.resolve();
      await service?.onApplicationShutdown();
      for (const run of executions) {
        run.finish.resolve();
        await run.execution;
        await seal(run.first.runId);
      }
      if (fixtures.length) await fixtures[0]!.queue.reconcileOnce();
    }
  });

  it("releases database locks before delivery and keeps pending promotions fair", async () => {
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let calls = 0;
    const f = await fixture(async () => {
      calls++;
      if (calls === 1) {
        entered.resolve();
        await release.promise;
      }
    });
    const run = await active(f);
    let reconcile: Promise<void> | undefined;
    try {
      const extra = await f.accept("editable");
      let q = await f.list();
      await f.queue.mutate(f.tenant.tenantId, f.session.sessionId, run.source.turnId, "promote", {
        action: "steer",
        revision: q.revision,
        targetTurnId: run.first.turnId,
      });
      reconcile = f.queue.reconcileOnce();
      await entered.promise;
      q = await f.list();
      await f.queue.mutate(f.tenant.tenantId, f.session.sessionId, extra.turnId, "edit", {
        action: "edit",
        revision: q.revision,
        text: "changed while HTTP waits",
      });
      release.resolve();
      await reconcile;
      // More than one batch of ACKed-but-unconsumed inputs cannot block a new due input.
      for (let i = 0; i < 32; i++) {
        const input = await f.accept(`promotion ${i}`);
        q = await f.list();
        await f.queue.mutate(f.tenant.tenantId, f.session.sessionId, input.turnId, `promote-${i}`, {
          action: "steer",
          revision: q.revision,
          targetTurnId: run.first.turnId,
        });
        await f.queue.reconcileOnce();
      }
      expect(calls).toBe(33);
    } finally {
      release.resolve();
      await reconcile;
      run.finish.resolve();
      await run.execution;
      await seal(run.first.runId);
      await f.queue.reconcileOnce();
      await f.queue.reconcileOnce();
    }
  }, 30000);
});
