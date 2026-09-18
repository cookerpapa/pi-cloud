import { randomUUID } from "node:crypto";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { sql, type Kysely, type Transaction } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentRunSupervisor } from "@pi-cloud/sandbox-supervisor";
import { AgentRunExecutionBackend } from "../../runtime-core/src/agent-run-execution-backend.ts";
import { RunExecutor, type TurnExecutionBackend } from "../../runtime-core/src/run-executor.ts";
import { SessionLeaseCoordinator } from "../../runtime-core/src/session-lease-coordinator.ts";
import { DirectExecutionLog } from "../../runtime-core/src/direct-execution-log.ts";
import { ExecutionStreamProjector } from "../../runtime-core/src/execution-stream-projection.ts";
import {
  ExecutionPublicationBoundary,
  registerExecutionPublication,
} from "../../runtime-core/src/execution-publication.ts";
import type { AcceptedFact } from "../../runtime-core/src/accepted-fact.ts";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { AssignmentReconciler } from "../src/assignment-reconciler.ts";

const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
describe.skipIf(!endpoint)("atomic Worker admission", () => {
  const name = `pi_atomic_admit_${randomUUID().replaceAll("-", "")}`;
  let admin: Kysely<Database>, db: Kysely<Database>;
  beforeAll(async () => {
    admin = createDatabase({ connectionString: endpoint!, maxConnections: 1 });
    await sql`create database ${sql.id(name)}`.execute(admin);
    const url = new URL(endpoint!);
    url.pathname = `/${name}`;
    url.searchParams.set(
      "options",
      "-c statement_timeout=5000 -c idle_in_transaction_session_timeout=10000",
    );
    db = createDatabase({ connectionString: url.toString(), maxConnections: 8 });
    await runMigrations(db, "up");
  }, 60000);
  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      try {
        await vi.waitFor(async () => {
          const rows = await sql<{
            n: number;
          }>`select count(*)::int n from pg_stat_activity where datname=${name}`.execute(admin);
          expect(rows.rows[0]!.n).toBe(0);
        });
        await sql`drop database ${sql.id(name)}`.execute(admin);
      } finally {
        await admin.destroy();
      }
    }
  });
  async function fixture(capacity = 2) {
    const tenant = await createPrivateTenant(db, {
      slug: `atomic-${randomUUID()}`,
      ownerDisplayName: "Admission test",
    });
    const store = new ControlPlaneStore({ database: db, ...tenant });
    const workspace = await store.createProject({ name: "atomic", source: { kind: "empty" } });
    const session = await store.createSession(
      workspace.projectId,
      workspace.workspaceId,
      "atomic",
      "elastic",
    );
    const worker = randomUUID();
    await db
      .insertInto("sandboxes")
      .values({
        id: worker,
        supervisor_id: worker,
        boot_id: randomUUID(),
        state: "ready",
        max_concurrent_sessions: capacity,
        active_sessions: 0,
      })
      .execute();
    const coordinator = new SessionLeaseCoordinator({ database: db, sandboxId: worker });
    const facts: AcceptedFact[] = [];
    const append = vi.fn(async (fact: AcceptedFact) => {
      // Kafka is called outside PG admission, after the independently committed start.
      const a = await db
        .selectFrom("run_attempts")
        .select(["state", "output_publication"])
        .where("id", "=", fact.scope.attemptId)
        .executeTakeFirstOrThrow();
      expect(a.state).not.toBe("claimed");
      expect(a.output_publication).not.toBeNull();
      facts.push(fact);
      return { factId: fact.factId, durable: true as const };
    });
    const logs = new DirectExecutionLog(db, { append, checkHealth: async () => {} });
    const runner = vi.fn(async () => ({ stopReason: "stop" }));
    const supervisor = new AgentRunSupervisor({
      runner: { run: runner },
      maxConcurrentSessions: capacity,
    });
    const backend = new AgentRunExecutionBackend({
      supervisor,
      leaseCoordinator: coordinator,
      executionLogs: logs,
    });
    const executor = (override: TurnExecutionBackend = backend, database = db) =>
      new RunExecutor({
        database,
        backend: override,
        executionAuthority: coordinator,
        claimOwnerId: worker,
      });
    const accepted = await store.acceptTurn(session.sessionId, randomUUID(), {
      prompt: "atomic test",
    });
    const state = async () => ({
      run: await db
        .selectFrom("runs")
        .select(["state", "attempt_count", "current_attempt_id"])
        .where("id", "=", accepted.runId)
        .executeTakeFirstOrThrow(),
      physical: await db
        .selectFrom("pi_sessions")
        .select(["lease_epoch", "active_writer_id"])
        .where("id", "=", session.sessionId)
        .executeTakeFirstOrThrow(),
      worker: await db
        .selectFrom("sandboxes")
        .select(["state", "active_sessions"])
        .where("id", "=", worker)
        .executeTakeFirstOrThrow(),
      leases: await db
        .selectFrom("session_leases")
        .select("lease_id")
        .where("tenant_id", "=", tenant.tenantId)
        .execute(),
      attempts: await db
        .selectFrom("run_attempts")
        .select("id")
        .where("tenant_id", "=", tenant.tenantId)
        .execute(),
    });
    async function project() {
      const boundary = new ExecutionPublicationBoundary(db),
        projector = new ExecutionStreamProjector(db);
      const seals = await db
        .selectFrom("outbox")
        .select("payload")
        .where("tenant_id", "=", tenant.tenantId)
        .execute();
      let offset = 0n;
      for (const fact of [...facts, ...seals.map((s) => s.payload as unknown as AcceptedFact)]) {
        const record = { fact, topic: `test-${worker}`, partition: 0, offset: offset++ };
        if (await boundary.accept(record)) await projector.project(record);
      }
    }
    return {
      tenant,
      store,
      workspace,
      project,
      session,
      worker,
      coordinator,
      backend,
      executor,
      accepted,
      state,
      append,
      runner,
      supervisor,
      facts,
    };
  }

  it("commits claim, lease and publication together; Kafka and Runner run only afterwards", async () => {
    const f = await fixture();
    const observed = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const pending = f
      .executor({
        admit: async (tx, r, mark) => {
          const a = await f.backend.admit(tx, r, mark);
          observed.resolve();
          await release.promise;
          return a;
        },
        execute: f.backend.execute.bind(f.backend),
      })
      .dispatchRun(f.accepted.runId);
    await observed.promise;
    try {
      const s = await f.state();
      expect(s.run.state).toBe("queued");
      expect(s.attempts).toEqual([]);
      expect(s.leases).toEqual([]);
      expect(s.worker.active_sessions).toBe(0);
      expect(f.append).not.toHaveBeenCalled();
      expect(f.runner).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    expect(await pending).toMatchObject({ status: "completed" });
    expect(f.runner).toHaveBeenCalledOnce();
    const a = await db
      .selectFrom("run_attempts")
      .selectAll()
      .where("run_id", "=", f.accepted.runId)
      .executeTakeFirstOrThrow();
    expect(a.output_publication).not.toBeNull();
    expect(a.output_seal_id).not.toBeNull();
    expect(a.execution_released_at).not.toBeNull();
    await f.project();
  });
  it.each(["lease", "publication"])(
    "rolls back the entire admission after %s fails",
    async (stage) => {
      const f = await fixture();
      const before = await f.state();
      const backend: TurnExecutionBackend = {
        admit: async (tx, r, mark) => {
          if (stage === "lease") await f.coordinator.acquireInTransaction(tx, r, mark);
          else await f.backend.admit(tx, r, mark);
          throw new Error(`injected ${stage} failure`);
        },
        execute: f.backend.execute.bind(f.backend),
      };
      await expect(f.executor(backend).dispatchRun(f.accepted.runId)).rejects.toThrow("injected");
      expect(await f.state()).toEqual(before);
      expect(f.append).not.toHaveBeenCalled();
      expect(f.runner).not.toHaveBeenCalled();
      expect(await f.executor().dispatchRun(f.accepted.runId)).toMatchObject({
        status: "completed",
        attempt: 1,
      });
    },
  );
  it.each([
    "failed_writer",
    "sealed_writer",
    "wrong_lane",
    "wrong_session",
    "wrong_turn",
    "wrong_writer",
    "wrong_physical_session",
  ])("publication's narrowed query still rejects %s and rolls admission back", async (fault) => {
    const f = await fixture();
    const before = await f.state();
    const backend: TurnExecutionBackend = {
      admit: async (tx, request, mark) => {
        const bound = await f.coordinator.acquireInTransaction(tx, request, mark);
        if (fault === "failed_writer" || fault === "sealed_writer")
          await tx
            .updateTable("run_attempts")
            .set(
              fault === "failed_writer"
                ? { native_writer_failed_at: new Date() }
                : { native_writer_sealed_at: new Date() },
            )
            .where("id", "=", request.piSessionWriterId)
            .execute();
        const publication = await registerExecutionPublication(tx, {
          ...bound,
          sessionId: fault === "wrong_session" ? randomUUID() : request.sessionId,
          turnId: fault === "wrong_turn" ? randomUUID() : request.turnId,
          nextEventSeq: Number(request.nextEventSeq),
          piSession: {
            id: fault === "wrong_physical_session" ? randomUUID() : request.piSessionId,
            lane: fault === "wrong_lane" ? "other" : request.piSessionLane,
            writerId: fault === "wrong_writer" ? randomUUID() : request.piSessionWriterId,
          },
        });
        return { ...bound, publication };
      },
      execute: f.backend.execute.bind(f.backend),
    };
    await expect(f.executor(backend).dispatchRun(f.accepted.runId)).rejects.toThrow(
      "current Session lease",
    );
    expect(await f.state()).toEqual(before);
    expect(f.append).not.toHaveBeenCalled();
    expect(f.runner).not.toHaveBeenCalled();
  });
  it("resolves a lost COMMIT reply by exact identity, never a second Attempt", async () => {
    const f = await fixture();
    const transaction = db.transaction.bind(db);
    let once = true;
    const injected = new Proxy(db, {
      get(target, key) {
        if (key === "transaction")
          return () => ({
            execute: async <T>(body: (tx: Transaction<Database>) => Promise<T>) => {
              const result = await transaction().execute(body);
              if (once) {
                once = false;
                throw new Error("lost COMMIT reply");
              }
              return result;
            },
          });
        const v = Reflect.get(target, key, target);
        return typeof v === "function" ? v.bind(target) : v;
      },
    }) as Kysely<Database>;
    expect(await f.executor(f.backend, injected).dispatchRun(f.accepted.runId)).toMatchObject({
      status: "completed",
      attempt: 1,
    });
    expect(f.runner).toHaveBeenCalledOnce();
    expect((await f.state()).attempts).toHaveLength(1);
  });
  it("a connection lost before COMMIT leaves accepted input queued and no admission", async () => {
    const f = await fixture();
    const before = await f.state();
    const backend: TurnExecutionBackend = {
      admit: async (tx, request, mark) => {
        const admitted = await f.backend.admit(tx, request, mark);
        const pid = await sql<{ pid: number }>`select pg_backend_pid() pid`.execute(tx);
        await sql`select pg_terminate_backend(${pid.rows[0]!.pid})`.execute(db);
        return admitted;
      },
      execute: f.backend.execute.bind(f.backend),
    };
    await expect(f.executor(backend).dispatchRun(f.accepted.runId)).rejects.toThrow();
    expect(await f.state()).toEqual(before);
    expect(f.runner).not.toHaveBeenCalled();
    expect(await f.executor().dispatchRun(f.accepted.runId)).toMatchObject({
      status: "completed",
      attempt: 1,
    });
  });
  it("retries a database-certified admission abort without publishing or consuming an Attempt", async () => {
    const f = await fixture();
    let attempts = 0;
    const backend: TurnExecutionBackend = {
      admit: async (tx, r, mark) => {
        const a = await f.backend.admit(tx, r, mark);
        if (attempts++ === 0)
          await sql`do $$ begin raise exception 'test serialization abort' using errcode='40001'; end $$`.execute(
            tx,
          );
        return a;
      },
      execute: f.backend.execute.bind(f.backend),
    };
    expect(await f.executor(backend).dispatchRun(f.accepted.runId)).toMatchObject({
      status: "completed",
      attempt: 1,
    });
    expect(attempts).toBe(2);
    expect(f.runner).toHaveBeenCalledOnce();
    expect((await f.state()).attempts).toHaveLength(1);
  });
  it("cancellation between admission and started prevents Kafka and Agent execution", async () => {
    const f = await fixture();
    const backend: TurnExecutionBackend = {
      admit: f.backend.admit.bind(f.backend),
      execute: async (r, l, a) => {
        // Represent a control transaction winning before durable started; public
        // cancellation only accepts running Turns, so don't bypass it via a fake API call.
        await db.transaction().execute(async (tx) => {
          await tx
            .updateTable("runs")
            .set({ state: "cancel_requested" })
            .where("id", "=", r.runId)
            .execute();
          await tx
            .updateTable("turns")
            .set({ state: "cancelling" })
            .where("id", "=", r.turnId)
            .execute();
          await tx
            .updateTable("sessions")
            .set({ state: "cancelling" })
            .where("id", "=", r.sessionId)
            .execute();
        });
        return f.backend.execute(r, l, a);
      },
    };
    await expect(f.executor(backend).dispatchRun(f.accepted.runId)).rejects.toThrow();
    expect(f.append).not.toHaveBeenCalled();
    expect(f.runner).not.toHaveBeenCalled();
  });
  it("preparation rejection releases the committed capacity before retry, without any Kafka opening", async () => {
    const f = await fixture();
    const prepare = f.supervisor.prepare.bind(f.supervisor);
    vi.spyOn(f.supervisor, "prepare").mockImplementationOnce((...args) => {
      const prepared = prepare(...args);
      prepared.releaseBeforeStart();
      throw Object.assign(new Error("preparation temporarily unavailable"), {
        code: "test_preparation",
        retryable: true,
      });
    });
    expect(await f.executor().dispatchRun(f.accepted.runId)).toMatchObject({
      status: "retry_scheduled",
    });
    expect(f.append).not.toHaveBeenCalled();
    expect((await f.state()).leases).toEqual([]);
    expect((await f.state()).worker.active_sessions).toBe(0);
    expect(await f.executor().dispatchRun(f.accepted.runId)).toMatchObject({
      status: "completed",
      attempt: 2,
    });
  });
  it("two concurrent Lanes bind to one lease, writer and family slot", async () => {
    const f = await fixture(1);
    const child = await f.store.createSession(
      f.workspace.projectId,
      f.workspace.workspaceId,
      "child",
      "elastic",
    );
    await db
      .insertInto("pi_session_lanes")
      .values({
        tenant_id: f.tenant.tenantId,
        session_id: f.session.sessionId,
        lane: "child",
        leaf_id: null,
      })
      .execute();
    await db
      .updateTable("sessions")
      .set({ pi_session_id: f.session.sessionId, pi_session_lane: "child" })
      .where("id", "=", child.sessionId)
      .execute();
    const childRun = await f.store.acceptTurn(child.sessionId, randomUUID(), { prompt: "child" });
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let count = 0;
    f.runner.mockImplementation(async () => {
      if (++count === 2) entered.resolve();
      await release.promise;
      return { stopReason: "stop" };
    });
    const pending = Promise.all([
      f.executor().dispatchRun(f.accepted.runId),
      f.executor().dispatchRun(childRun.runId),
    ]);
    try {
      await Promise.race([
        entered.promise,
        pending.then(() => {
          throw new Error("Lanes did not both start");
        }),
      ]);
      const s = await f.state();
      expect(s.worker.active_sessions).toBe(1);
      expect(s.leases).toHaveLength(1);
      const attempts = await db
        .selectFrom("run_attempts")
        .select(["lease_id", "native_writer_id"])
        .where("tenant_id", "=", f.tenant.tenantId)
        .execute();
      expect(new Set(attempts.map((a) => a.lease_id)).size).toBe(1);
      expect(new Set(attempts.map((a) => a.native_writer_id)).size).toBe(1);
    } finally {
      release.resolve();
      await pending;
    }
    expect((await f.state()).worker.active_sessions).toBe(0);
  });
  it("competing claims start once and capacity rejection does not consume an Attempt", async () => {
    const f = await fixture(1),
      entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    f.runner.mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return { stopReason: "stop" };
    });
    const running = f.executor().dispatchRun(f.accepted.runId);
    await entered.promise;
    try {
      expect(await f.executor().dispatchRun(f.accepted.runId)).toEqual({ status: "idle" });
      const s = await f.store.createSession(
        f.workspace.projectId,
        f.workspace.workspaceId,
        "second",
        "elastic",
      );
      const r = await f.store.acceptTurn(s.sessionId, randomUUID(), { prompt: "second" });
      await expect(f.executor().dispatchRun(r.runId)).rejects.toMatchObject({ code: "capacity" });
      expect(
        await db
          .selectFrom("runs")
          .select(["state", "attempt_count"])
          .where("id", "=", r.runId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: "queued", attempt_count: 0 });
    } finally {
      release.resolve();
      await running;
    }
  });
  it("a lost opening ACK fails and seals, without starting or replaying the Agent", async () => {
    const f = await fixture();
    f.append.mockImplementation(async (fact) => {
      f.facts.push(fact);
      throw new Error("lost Kafka ACK");
    });
    expect(await f.executor().dispatchRun(f.accepted.runId)).toMatchObject({
      status: "failed",
      phase: "after_start",
    });
    expect(f.runner).not.toHaveBeenCalled();
    expect((await f.state()).leases).toEqual([]);
    expect(await f.executor().dispatchRun(f.accepted.runId)).toEqual({ status: "idle" });
    await f.project();
    expect(
      (
        await db
          .selectFrom("run_attempts")
          .select("output_sealed_at")
          .where("run_id", "=", f.accepted.runId)
          .executeTakeFirstOrThrow()
      ).output_sealed_at,
    ).not.toBeNull();
  });
  it("owner loss before started can requeue, but a bound claim cannot be stolen on its shorter deadline", async () => {
    const f = await fixture();
    await expect(
      f
        .executor({
          admit: f.backend.admit.bind(f.backend),
          execute: async () => {
            throw new Error("test crash");
          },
        })
        .dispatchNext(
          {
            allowedFamilyKeys: [`${f.tenant.tenantId}:${f.session.sessionId}`],
            blockedFamilyKeys: [],
          },
          () => {
            throw new Error("crash after commit");
          },
        ),
    ).rejects.toThrow("crash after commit");
    await db
      .updateTable("runs")
      .set({ available_at: new Date(0) })
      .where("id", "=", f.accepted.runId)
      .execute();
    await db
      .updateTable("run_attempts")
      .set({
        claimed_at: new Date(Date.now() - 120000),
        claim_expires_at: new Date(Date.now() - 60000),
      })
      .where("run_id", "=", f.accepted.runId)
      .execute();
    expect(await f.executor().dispatchRun(f.accepted.runId)).toEqual({ status: "idle" });
    expect(f.facts).toEqual([]);
    await db
      .updateTable("session_leases")
      .set({
        acquired_at: new Date(Date.now() - 120000),
        renewed_at: new Date(Date.now() - 120000),
        valid_until: new Date(Date.now() - 60000),
      })
      .where("tenant_id", "=", f.tenant.tenantId)
      .execute();
    const reconciler = new AssignmentReconciler({
      database: db,
      sandboxId: f.worker,
      inventory: { listAssignments: async () => [], terminateAndConfirmAbsent: async () => {} },
    });
    await reconciler.retireExpiredAssignments();
    expect((await f.state()).run.state).toBe("queued");
    expect(await f.executor().dispatchRun(f.accepted.runId)).toMatchObject({
      status: "completed",
      attempt: 2,
    });
  });
});
