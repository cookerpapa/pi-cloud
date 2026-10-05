import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { sql, type Kysely, type QueryId } from "kysely";
import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { parseKafkaAcceptedFact } from "@pi-cloud/runtime-core/kafka-accepted-fact";
import { projectNativeSessionAppend } from "@pi-cloud/pi-session-postgres";
import { ExecutionStreamProjector } from "@pi-cloud/runtime-core";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { QueuedInputService } from "../src/queued-input-service.ts";
import { TurnSteeringService } from "../src/turn-steering-service.ts";
import { TurnSteerBackendError, type TurnSteerRequest } from "../src/turn-steer.ts";
import { createTestWorker } from "./admit-test-execution.ts";
import { TurnExecutionCancelledError } from "@pi-cloud/runtime-core/run-executor";
import { RunCancellationExecutor } from "@pi-cloud/runtime-core/run-cancellation-executor";

const external = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
describe.sequential("pending conversation inputs", () => {
  let database: Kysely<Database>;
  let admin: Pool | undefined, name: string, url: string;
  let offset = 0n;
  beforeAll(async () => {
    if (!external)
      throw new Error(
        "Queued input tests require real PostgreSQL; npm test --workspace @pi-cloud/control-plane supplies an isolated fixture",
      );
    admin = new Pool({ connectionString: external, max: 1 });
    name = `queue_inputs_${randomUUID().replaceAll("-", "")}`;
    await admin.query(`create database "${name}"`);
    const endpoint = new URL(external);
    endpoint.pathname = `/${name}`;
    endpoint.searchParams.set("options", "-c lock_timeout=1000 -c statement_timeout=5000");
    url = endpoint.toString();
    database = createDatabase({ connectionString: url, maxConnections: 8 });
    await runMigrations(database, "up");
  }, 60000);
  afterAll(async () => {
    await database?.destroy();
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
    const listAll = async () => {
      let page = await list();
      const items = [...page.items];
      while (page.hasMore) {
        page = await queue.list(tenant.tenantId, session.sessionId, {
          afterPosition: page.items.at(-1)!.mailboxPosition,
          viewVersion: page.viewVersion,
        });
        items.push(...page.items);
      }
      return items;
    };
    const accept = (text: string, key: string = randomUUID()) =>
      store.acceptTurn(session.sessionId, key, { prompt: text });
    return { tenant, store, session, queue, steering, list, listAll, accept };
  }
  it("pages unbounded queues without mixing revisions or reading all input bodies", async () => {
    const f = await fixture();
    for (let i = 0; i < 65; i++) await f.accept(`${i}:` + "x".repeat(4096));
    const first = await f.list();
    expect(first.items).toHaveLength(20);
    expect(first.hasMore).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(90_000);
    expect(await f.listAll()).toHaveLength(65);
    const cursor = {
      afterPosition: first.items.at(-1)!.mailboxPosition,
      viewVersion: first.viewVersion,
    };
    const second = await f.queue.list(f.tenant.tenantId, f.session.sessionId, cursor);
    expect(second.items[0]?.text.startsWith("20:")).toBe(true);
    await f.queue.mutate(
      f.tenant.tenantId,
      f.session.sessionId,
      second.items[0]!.turnId,
      randomUUID(),
      {
        action: "move",
        direction: "up",
        revision: first.revision,
      },
    );
    await expect(
      f.queue.list(f.tenant.tenantId, f.session.sessionId, cursor),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      f.queue.list(f.tenant.tenantId, f.session.sessionId, { afterPosition: 20 }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

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
  async function active(f: Awaited<ReturnType<typeof fixture>>, fail: boolean | "cancel" = false) {
    const first = await f.accept("active task");
    const source = await f.accept("queued instruction");
    const entered = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>(),
      exited = Promise.withResolvers<void>();
    let reference = "";
    const worker = await createTestWorker(database);
    const execution = worker
      .executor({
        execute: async (_r, listener, admission) => {
          reference = admission.executionReference;
          entered.resolve();
          await finish.promise;
          if (fail === "cancel") {
            listener.executionExited();
            exited.resolve();
            throw new TurnExecutionCancelledError("user_request", false);
          }
          if (fail) throw new Error("Worker stopped before consuming pending input");
          return { stopReason: "stop" };
        },
      })
      .dispatchRun(first.runId);
    void execution.catch((error) => entered.reject(error));
    await entered.promise;
    return { first, source, worker, finish, execution, exited, reference };
  }
  async function cancelActive(
    f: Awaited<ReturnType<typeof fixture>>,
    run: Awaited<ReturnType<typeof active>>,
  ) {
    await f.store.acceptTurnCancellation(f.session.sessionId, run.first.turnId, "stop", {});
    const cancellation = new RunCancellationExecutor({
      database,
      executionAuthority: run.worker.coordinator,
      backend: {
        async cancel(request, listener) {
          await listener.started({ executionReference: run.reference });
          run.finish.resolve();
          await run.exited.promise;
          return { reason: request.reason, forced: false };
        },
      },
    });
    expect(await cancellation.dispatchTargetRun(run.first.runId)).toMatchObject({
      status: "cancelled",
    });
    await run.execution;
    await seal(run.first.runId);
  }

  it("withdraws exactly Stop's queue cut, retaining uploads and lost-response recovery", async () => {
    const f = await fixture();
    const run = await active(f, "cancel");
    try {
      const c = await f.accept("old C");
      const upload = {
        id: randomUUID(),
        sessionId: f.session.sessionId,
        workspaceId: f.session.workspaceId,
        name: "instructions.txt",
        path: "/workspace/uploads/instructions.txt",
        mimeType: "text/plain",
        byteLength: 4,
        sha256: "a".repeat(64),
      };
      await database
        .updateTable("turns")
        .set({ input_uploads: sql`${JSON.stringify([upload])}::jsonb` })
        .where("id", "=", c.turnId)
        .execute();
      await f.store.acceptTurnCancellation(f.session.sessionId, run.first.turnId, "stop", {});
      expect(await f.list()).toMatchObject({ items: [], hasReturnedInputs: true });
      const fresh = await f.accept("new conversation");
      expect(
        await f.store.acceptTurnCancellation(f.session.sessionId, run.first.turnId, "stop", {}),
      ).toMatchObject({ replayed: true });
      expect((await f.list()).items.map((i) => i.turnId)).toEqual([fresh.turnId]);
      await expect(
        f.store.acceptTurnSteer(f.session.sessionId, run.first.turnId, "late", {
          text: "too late",
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      await cancelActive(f, run);
      const restarted = new QueuedInputService({ database, steering: f.steering });
      const returned = await restarted.returned(f.tenant.tenantId, f.session.sessionId);
      expect(returned.pending).toBe(false);
      expect(returned.items.map((i) => i.text)).toEqual(["queued instruction", "old C"]);
      expect(returned.items[1]?.uploads).toEqual([upload]);
      expect(await restarted.returned(f.tenant.tenantId, f.session.sessionId)).toEqual(returned);
      await expect(restarted.returned(randomUUID(), f.session.sessionId)).rejects.toMatchObject({
        code: "not_found",
      });
      const seen: string[] = [];
      const executor = run.worker.executor({
        execute: async (r) => {
          seen.push(r.input.prompt);
          return { stopReason: "stop" };
        },
      });
      expect(await executor.dispatchRun(run.source.runId)).toMatchObject({ status: "idle" });
      expect(await executor.dispatchRun(c.runId)).toMatchObject({ status: "idle" });
      expect(await executor.dispatchRun(fresh.runId)).toMatchObject({ status: "completed" });
      await seal(fresh.runId);
      expect(seen).toEqual(["new conversation"]);
      const receipt = { turnIds: returned.items.map((i) => i.turnId) };
      await restarted.acknowledgeReturned(f.tenant.tenantId, f.session.sessionId, receipt);
      await restarted.acknowledgeReturned(f.tenant.tenantId, f.session.sessionId, receipt);
      expect((await restarted.returned(f.tenant.tenantId, f.session.sessionId)).items).toEqual([]);
      expect((await f.list()).hasReturnedInputs).toBe(false);
    } finally {
      run.finish.resolve();
      await run.execution;
    }
  });

  it.each([false, true])(
    "settles Stop's in-flight Steer by canonical consumption (consumed=%s)",
    async (consumed) => {
      let delivered!: TurnSteerRequest;
      const f = await fixture(async (r) => {
        delivered = r;
      });
      const run = await active(f, "cancel");
      try {
        const input = await f.store.acceptTurnSteer(
          f.session.sessionId,
          run.first.turnId,
          "steer",
          { text: "in flight" },
        );
        await f.queue.reconcileOnce();
        await f.store.acceptTurnCancellation(f.session.sessionId, run.first.turnId, "stop", {});
        expect(await f.queue.returned(f.tenant.tenantId, f.session.sessionId)).toMatchObject({
          pending: true,
          items: [],
        });
        if (consumed) await recordInput(delivered);
        await cancelActive(f, run);
        await new QueuedInputService({ database, steering: f.steering }).reconcileOnce();
        expect((await f.list()).items).toEqual([]);
        const returned = await f.queue.returned(f.tenant.tenantId, f.session.sessionId);
        expect(returned.pending).toBe(false);
        expect(returned.items.map((i) => i.text)).toEqual(
          consumed ? ["queued instruction"] : ["queued instruction", "in flight"],
        );
        const backend = vi.fn(async () => ({ stopReason: "stop" }));
        expect(
          await run.worker.executor({ execute: backend }).dispatchRun(input.sourceRunId),
        ).toMatchObject({ status: "idle" });
        expect(backend).not.toHaveBeenCalled();
      } finally {
        run.finish.resolve();
        await run.execution;
      }
    },
  );

  it("returns every page in edited order and isolates repeated acknowledgements", async () => {
    const f = await fixture(),
      run = await active(f, "cancel");
    try {
      for (let i = 0; i < 44; i++) await f.accept(`message ${i}`);
      const q = await f.list(),
        second = q.items[1]!;
      await f.queue.mutate(f.tenant.tenantId, f.session.sessionId, second.turnId, "up", {
        action: "move",
        direction: "up",
        revision: q.revision,
      });
      const expected = (await f.listAll()).map((i) => i.turnId);
      await cancelActive(f, run);
      const found: string[] = [];
      let reads = 0;
      while (true) {
        const page = await f.queue.returned(f.tenant.tenantId, f.session.sessionId);
        expect(page.pending).toBe(false);
        expect(page.items.length).toBeLessThanOrEqual(20);
        if (!page.items.length) break;
        found.push(...page.items.map((i) => i.turnId));
        const ack = { turnIds: page.items.map((i) => i.turnId) };
        await f.queue.acknowledgeReturned(f.tenant.tenantId, f.session.sessionId, ack);
        await f.queue.acknowledgeReturned(f.tenant.tenantId, f.session.sessionId, ack);
        reads++;
      }
      expect(reads).toBe(3);
      expect(found).toEqual(expected);
      expect((await f.list()).hasReturnedInputs).toBe(false);
    } finally {
      run.finish.resolve();
      await run.execution;
    }
  });
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

  it("rejects the serialized input budget before acceptance, edit or promotion commits", async () => {
    const f = await fixture();
    const run = await active(f);
    const oversized = "fixture:" + "\u0001".repeat(99992);
    try {
      const before = await f.list();
      const count = await database
        .selectFrom("runs")
        .select("id")
        .where("tenant_id", "=", f.tenant.tenantId)
        .execute();
      await expect(f.accept(oversized)).rejects.toMatchObject({ code: "invalid_request" });
      await expect(
        f.store.acceptTurnSteer(f.session.sessionId, run.first.turnId, randomUUID(), {
          text: oversized,
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      for (const action of [
        { action: "edit" as const, text: oversized, revision: before.revision },
        {
          action: "steer" as const,
          text: oversized,
          revision: before.revision,
          targetTurnId: run.first.turnId,
        },
      ])
        await expect(
          f.queue.mutate(
            f.tenant.tenantId,
            f.session.sessionId,
            run.source.turnId,
            randomUUID(),
            action,
          ),
        ).rejects.toMatchObject({ code: "invalid_request" });
      expect(await f.list()).toEqual(before);
      expect(
        await database
          .selectFrom("runs")
          .select("id")
          .where("tenant_id", "=", f.tenant.tenantId)
          .execute(),
      ).toEqual(count);
    } finally {
      run.finish.resolve();
      await run.execution;
      await seal(run.first.runId);
    }
  });

  it("atomically accepts direct Steer with the active Run settings and one retry identity", async () => {
    const f = await fixture();
    const run = await active(f);
    try {
      await database
        .updateTable("sessions")
        .set({ desired_thinking_level: "high" })
        .where("id", "=", f.session.sessionId)
        .execute();
      const statements: string[] = [];
      const measured = new ControlPlaneStore({
        ...f.tenant,
        database: database.withPlugin({
          transformQuery({ node, queryId }) {
            statements.push(database.getExecutor().compileQuery(node, queryId).sql);
            return node;
          },
          async transformResult({ result }) {
            return result;
          },
        }),
      });
      const accepted = await measured.acceptTurnSteer(
        f.session.sessionId,
        run.first.turnId,
        "direct",
        { text: "  preserve me  " },
      );
      const receiptReads = () =>
        statements.filter((query) =>
          query.startsWith('select "id", "target_run_id" from "turn_control_requests"'),
        );
      expect(receiptReads()).toEqual([]);
      expect(accepted).toMatchObject({ state: "accepted", targetRunId: run.first.runId });
      const q = await f.list();
      expect(q.items.map(({ text, status }) => ({ text, status }))).toEqual([
        { text: "queued instruction", status: "queued" },
        { text: "preserve me", status: "steering" },
      ]);
      const snapshots = await database
        .selectFrom("runs as r")
        .innerJoin("turns as t", "t.id", "r.turn_id")
        .select([
          "r.id",
          "r.environment_version_id",
          "r.working_directory",
          "r.tool_capability_snapshot",
          "r.agent_revision_id",
          "r.sandbox_profile_key",
          "r.ready_at",
          "r.lease_id",
          "t.model_profile_id",
          "t.provider",
          "t.model_id",
          "t.thinking_level",
          "t.service_tier",
          "t.credential_binding_id",
          "t.credential_binding_version",
        ])
        .where("r.id", "in", [run.first.runId, accepted.sourceRunId])
        .execute();
      const {
        id: _a,
        ready_at: _b,
        lease_id: _c,
        ...original
      } = snapshots.find((r) => r.id === run.first.runId)!;
      const {
        id: _d,
        ready_at,
        lease_id,
        ...source
      } = snapshots.find((r) => r.id === accepted.sourceRunId)!;
      expect(source).toEqual(original);
      expect(ready_at).toBeNull();
      expect(lease_id).toBeNull();
      const controls = await database
        .selectFrom("turn_control_requests")
        .selectAll()
        .where("id", "=", accepted.controlRequestId)
        .executeTakeFirstOrThrow();
      expect(controls.payload).not.toHaveProperty("text");
      expect(controls.payload).not.toHaveProperty("uploads");
      expect(controls.state).toBe("pending");
      for (const [target, text] of [
        [run.first.turnId, "different"],
        [run.source.turnId, "preserve me"],
      ])
        await expect(
          f.store.acceptTurnSteer(f.session.sessionId, target!, "direct", { text: text! }),
        ).rejects.toMatchObject({ code: "idempotency_conflict" });
      await expect(f.accept("preserve me", "direct")).rejects.toMatchObject({
        code: "idempotency_conflict",
      });
      run.finish.resolve();
      await run.execution;
      await seal(run.first.runId);
      await f.queue.reconcileOnce();
      expect(
        await measured.acceptTurnSteer(f.session.sessionId, run.first.turnId, "direct", {
          text: "preserve me",
        }),
      ).toEqual({ ...accepted, replayed: true });
      expect(receiptReads()).toHaveLength(1);
      expect((await f.list()).items.at(-1)).toMatchObject({
        turnId: accepted.sourceTurnId,
        status: "queued",
      });
    } finally {
      run.finish.resolve();
      await run.execution;
      await seal(run.first.runId);
    }
  });

  it.each([false, true])(
    "restores direct Steer acknowledged but unconsumed when its target ends (failed=%s)",
    async (failed) => {
      let calls = 0;
      const f = await fixture(async () => {
        calls++;
      });
      const run = await active(f, failed);
      try {
        const accepted = await f.store.acceptTurnSteer(
          f.session.sessionId,
          run.first.turnId,
          "direct",
          { text: "recover this instruction" },
        );
        const later = await f.accept("later instruction");
        await f.queue.reconcileOnce();
        expect(calls).toBe(1);
        expect(
          await database
            .selectFrom("turn_control_requests")
            .select(["state", "completed_at"])
            .where("id", "=", accepted.controlRequestId)
            .executeTakeFirst(),
        ).toEqual({ state: "acknowledged", completed_at: null });
        const restarted = new QueuedInputService({ database, steering: f.steering });
        await restarted.reconcileOnce();
        expect(calls).toBe(1);
        run.finish.resolve();
        await run.execution;
        await restarted.reconcileOnce();
        expect((await f.list()).items.find((i) => i.turnId === accepted.sourceTurnId)?.status).toBe(
          "steering",
        );
        await seal(run.first.runId);
        await restarted.reconcileOnce();
        expect((await f.list()).items.map((i) => [i.turnId, i.status])).toEqual([
          [run.source.turnId, "queued"],
          [accepted.sourceTurnId, "queued"],
          [later.turnId, "queued"],
        ]);
        const executed: string[] = [];
        for (const id of [run.source.runId, accepted.sourceRunId, later.runId]) {
          expect(
            await run.worker
              .executor({
                execute: async (r) => {
                  executed.push(r.input.prompt);
                  return { stopReason: "stop" };
                },
              })
              .dispatchRun(id),
          ).toMatchObject({ status: "completed" });
          await seal(id);
        }
        expect(executed).toEqual([
          "queued instruction",
          "recover this instruction",
          "later instruction",
        ]);
        await restarted.reconcileOnce();
        expect(calls).toBe(1);
      } finally {
        run.finish.resolve();
        await run.execution;
        await seal(run.first.runId);
      }
    },
  );

  it("recovers acknowledged Steer scopes and wakes them for canonical consumption without idle reads", async () => {
    let delivered: TurnSteerRequest | undefined;
    const f = await fixture(async (request) => {
      delivered = request;
    });
    const run = await active(f);
    let reads = 0;
    const measured = database.withPlugin({
      transformQuery({ node }) {
        reads++;
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    const service = new QueuedInputService({
      database: measured,
      steering: f.steering,
      autoStart: true,
    });
    try {
      const accepted = await f.store.acceptTurnSteer(
        f.session.sessionId,
        run.first.turnId,
        "indexed",
        { text: "keep me through ACK" },
      );
      await f.queue.reconcileOnce();
      expect(delivered).toBeDefined();
      service.onModuleInit();
      await service.recoverPending({ partitionCount: 1, partitions: [0], current: () => true });
      await vi.waitFor(() => expect(reads).toBe(3));
      reads = 0;
      service.notifySession(f.tenant.tenantId, randomUUID());
      await new Promise((resolve) => setTimeout(resolve, 1100));
      expect(reads).toBe(0);
      await recordInput(delivered!);
      service.notifySession(f.tenant.tenantId, f.session.sessionId);
      await vi.waitFor(async () =>
        expect((await f.list()).items.some((i) => i.turnId === accepted.sourceTurnId)).toBe(false),
      );
    } finally {
      await service.onApplicationShutdown();
      run.finish.resolve();
      await run.execution;
      await seal(run.first.runId);
    }
  });

  it("retires direct Steer only after canonical consumption even when its HTTP reply is lost", async () => {
    let delivered: TurnSteerRequest | undefined;
    const f = await fixture(async (request) => {
      delivered = request;
      throw new TurnSteerBackendError("reply_lost", "Reply lost", true, true);
    });
    const run = await active(f, true);
    try {
      const accepted = await f.store.acceptTurnSteer(
        f.session.sessionId,
        run.first.turnId,
        "direct",
        { text: "already consumed" },
      );
      await f.queue.reconcileOnce();
      expect((await f.list()).items.find((i) => i.turnId === accepted.sourceTurnId)?.status).toBe(
        "steering",
      );
      // Represent the delayed projection of the Worker's acknowledged Kafka Entry.
      await recordInput(delivered!);
      await f.queue.reconcileOnce();
      expect((await f.list()).items.some((i) => i.turnId === accepted.sourceTurnId)).toBe(false);
      run.finish.resolve();
      await run.execution;
      await seal(run.first.runId);
      await new QueuedInputService({ database, steering: f.steering }).reconcileOnce();
      expect(
        await database
          .selectFrom("runs")
          .select(["state", "started_at", "lease_id", "stop_reason"])
          .where("id", "=", accepted.sourceRunId)
          .executeTakeFirst(),
      ).toEqual({
        state: "cancelled",
        started_at: null,
        lease_id: null,
        stop_reason: "queued_input_steered",
      });
      expect((await f.list()).items.map((i) => i.turnId)).toEqual([run.source.turnId]);
    } finally {
      run.finish.resolve();
      await run.execution;
      await seal(run.first.runId);
    }
  });

  it.each(["consumed-success", "consumed-error", "restored-success", "restored-error"])(
    "preserves direct Steer reconciliation against a late delivery outcome (%s)",
    async (scenario) => {
      const entered = Promise.withResolvers<TurnSteerRequest>(),
        release = Promise.withResolvers<void>();
      const f = await fixture(async (request) => {
        entered.resolve(request);
        await release.promise;
        if (scenario.endsWith("error"))
          throw new TurnSteerBackendError("connection_lost", "lost", true, true);
      });
      const run = await active(f);
      let delivery: Promise<void> | undefined;
      try {
        const accepted = await f.store.acceptTurnSteer(
          f.session.sessionId,
          run.first.turnId,
          "direct",
          { text: "pending" },
        );
        delivery = f.queue.reconcileOnce();
        const request = await entered.promise;
        const other = new QueuedInputService({ database, steering: f.steering });
        const consumed = scenario.startsWith("consumed");
        if (consumed) await recordInput(request);
        else {
          run.finish.resolve();
          await run.execution;
          await seal(run.first.runId);
        }
        await other.reconcileOnce();
        release.resolve();
        await delivery;
        const row = await database
          .selectFrom("turn_control_requests")
          .select(["state", "failure_code"])
          .where("id", "=", accepted.controlRequestId)
          .executeTakeFirst();
        expect(row).toEqual({
          state: consumed ? "completed" : "failed",
          failure_code: consumed ? null : "steer_not_consumed",
        });
        expect((await f.list()).items.some((i) => i.turnId === accepted.sourceTurnId)).toBe(
          !consumed,
        );
      } finally {
        release.resolve();
        await delivery;
        run.finish.resolve();
        await run.execution;
        await seal(run.first.runId);
      }
    },
  );

  it("deduplicates simultaneous direct Steer acceptance and rejects locked targets without orphaned input", async () => {
    const f = await fixture();
    const run = await active(f);
    const pool = new Pool({ connectionString: url, max: 1 });
    const locker = await pool.connect();
    try {
      const accepts = await Promise.all(
        [1, 2].map(() =>
          f.store.acceptTurnSteer(f.session.sessionId, run.first.turnId, "direct", {
            text: "one input",
          }),
        ),
      );
      expect(new Set(accepts.map((v) => v.sourceRunId)).size).toBe(1);
      expect(accepts.map((v) => v.replayed).sort()).toEqual([false, true]);
      const before = await f.list();
      await locker.query("begin");
      await locker.query("select id from runs where id=$1 for no key update", [run.first.runId]);
      await expect(
        f.store.acceptTurnSteer(f.session.sessionId, run.first.turnId, "locked", {
          text: "must not leak",
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      await locker.query("rollback");
      expect(await f.list()).toEqual(before);
      expect(
        await database
          .selectFrom("turn_control_requests")
          .select("id")
          .where("tenant_id", "=", f.tenant.tenantId)
          .where("idempotency_key", "=", "locked")
          .execute(),
      ).toEqual([]);
    } finally {
      await locker.query("rollback");
      locker.release();
      await pool.end();
      run.finish.resolve();
      await run.execution;
      await seal(run.first.runId);
    }
  });

  it("returns unconsumed direct Steer only after ordered closure", async () => {
    const f = await fixture();
    const first = await f.accept("wait for cancellation");
    const worker = await createTestWorker(database);
    const entered = Promise.withResolvers<void>(),
      interrupt = Promise.withResolvers<void>(),
      exited = Promise.withResolvers<void>();
    let reference!: string;
    const execution = worker
      .executor({
        async execute(_r, listener, admission) {
          reference = admission.executionReference;
          entered.resolve();
          await interrupt.promise;
          listener.executionExited();
          exited.resolve();
          throw new TurnExecutionCancelledError("user_request", false);
        },
      })
      .dispatchRun(first.runId);
    void execution.catch(entered.reject);
    await entered.promise;
    try {
      const accepted = await f.store.acceptTurnSteer(f.session.sessionId, first.turnId, "direct", {
        text: "survives stop",
      });
      await f.queue.reconcileOnce();
      await f.store.acceptTurnCancellation(f.session.sessionId, first.turnId, "cancel", {});
      const cancellation = new RunCancellationExecutor({
        database,
        executionAuthority: worker.coordinator,
        backend: {
          async cancel(request, listener) {
            await listener.started({ executionReference: reference });
            interrupt.resolve();
            await exited.promise;
            return { reason: request.reason, forced: false };
          },
        },
      });
      expect(await cancellation.dispatchTargetRun(first.runId)).toMatchObject({
        status: "cancelled",
      });
      await execution;
      await f.queue.reconcileOnce();
      expect(await f.queue.returned(f.tenant.tenantId, f.session.sessionId)).toMatchObject({
        pending: true,
        items: [],
      });
      await seal(first.runId);
      await f.queue.reconcileOnce();
      expect(
        (await f.queue.returned(f.tenant.tenantId, f.session.sessionId)).items[0],
      ).toMatchObject({
        turnId: accepted.sourceTurnId,
        text: "survives stop",
      });
      await f.queue.acknowledgeReturned(f.tenant.tenantId, f.session.sessionId, {
        turnIds: [accepted.sourceTurnId],
      });
      expect((await f.list()).items).toEqual([]);
      expect(
        await database
          .selectFrom("runs")
          .select(["state", "lease_id"])
          .where("id", "=", accepted.sourceRunId)
          .executeTakeFirst(),
      ).toEqual({ state: "cancelled", lease_id: null });
    } finally {
      interrupt.resolve();
      await execution;
    }
  });

  it("enforces direct Steer tenant, control identity and queue capacity atomically", async () => {
    const f = await fixture(),
      other = await fixture();
    const run = await active(f);
    try {
      await expect(
        other.store.acceptTurnSteer(f.session.sessionId, run.first.turnId, "foreign", {
          text: "no access",
        }),
      ).rejects.toMatchObject({ code: "not_found" });
      const q = await f.list();
      await f.queue.mutate(f.tenant.tenantId, f.session.sessionId, run.source.turnId, "taken", {
        action: "edit",
        revision: q.revision,
        text: "edited",
      });
      const before = await f.list();
      await expect(
        f.store.acceptTurnSteer(f.session.sessionId, run.first.turnId, "taken", {
          text: "collision",
        }),
      ).rejects.toMatchObject({ code: "idempotency_conflict" });
      expect(await f.list()).toEqual(before);
      for (let i = before.items.length; i < 65; i++) await f.accept(`input ${i}`);
      await f.store.acceptTurnSteer(f.session.sessionId, run.first.turnId, "overflow", {
        text: "accepted without a count quota",
      });
      expect(await f.listAll()).toHaveLength(66);
      expect(
        await database
          .selectFrom("turn_control_requests")
          .select("id")
          .where("tenant_id", "=", f.tenant.tenantId)
          .where("idempotency_key", "in", ["foreign"])
          .execute(),
      ).toEqual([]);
    } finally {
      run.finish.resolve();
      await run.execution;
      await seal(run.first.runId);
    }
  });

  it("edits, reorders and cancels pending inputs without changing original acceptance identity", async () => {
    const f = await fixture();
    const a = await f.accept("A"),
      b = await f.accept("B", "original-b"),
      c = await f.accept("C");
    const queries: string[] = [];
    const measured = new QueuedInputService({
      database: database.withPlugin({
        transformQuery({ node, queryId }) {
          queries.push(database.getExecutor().compileQuery(node, queryId).sql);
          return node;
        },
        async transformResult({ result }) {
          return result;
        },
      }),
      steering: f.steering,
    });
    let q = await measured.list(f.tenant.tenantId, f.session.sessionId);
    expect(queries).toHaveLength(1);
    expect(q.activeTurnId).toBeNull();
    expect(q.items.map((item) => item.turnId)).toEqual([a.turnId, b.turnId, c.turnId]);
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
    for (let i = 1; i < 65; i++) await f.accept(`input ${i}`);
    await f.accept("overflow");
    expect(await f.listAll()).toHaveLength(66);
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
    expect(await f.listAll()).toHaveLength(45);
  });

  it("deduplicates concurrent replicas and rejects a competing stale queue mutation", async () => {
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
  });

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
      void service.recoverPending({ partitionCount: 1, partitions: [0], current: () => true });
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
