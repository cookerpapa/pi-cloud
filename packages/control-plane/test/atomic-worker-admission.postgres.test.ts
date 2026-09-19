import { randomUUID } from "node:crypto";
import {
  createDatabase,
  runMigrations,
  PostgresNotificationWake,
  type Database,
} from "@pi-cloud/database";
import { AcceptedFactTerminalOutboxRelay } from "../../runtime-core/src/accepted-fact-terminal-outbox-relay.ts";
import { TERMINAL_OUTBOX_NOTIFICATION_CHANNEL } from "../../runtime-core/src/execution-stream-seal.ts";
import { sql, type Kysely, type Transaction } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentRunSupervisor } from "@pi-cloud/sandbox-supervisor";
import type { ExecuteTurnCommandMessage, EventPublishMessage } from "@pi-cloud/protocol";
import { AgentRunExecutionBackend } from "../../runtime-core/src/agent-run-execution-backend.ts";
import { RunExecutor, type TurnExecutionBackend } from "../../runtime-core/src/run-executor.ts";
import { RunCancellationExecutor } from "../../runtime-core/src/run-cancellation-executor.ts";
import { SessionLeaseCoordinator } from "../../runtime-core/src/session-lease-coordinator.ts";
import { DirectExecutionLog } from "../../runtime-core/src/direct-execution-log.ts";
import { ExecutionStreamProjector } from "../../runtime-core/src/execution-stream-projection.ts";
import {
  ExecutionPublicationBoundary,
  registerExecutionPublication,
} from "../../runtime-core/src/execution-publication.ts";
import type { AcceptedFact } from "../../runtime-core/src/accepted-fact.ts";
import {
  loadFactReplayOffsets,
  recordFactProjection,
} from "../../runtime-core/src/accepted-fact-recovery.ts";
import { acceptedFactRetentionFloors } from "../../runtime-core/src/kafka-safe-retention.ts";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { AssignmentReconciler } from "../src/assignment-reconciler.ts";

const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
describe.skipIf(!endpoint)("atomic Worker admission", () => {
  const name = `pi_atomic_admit_${randomUUID().replaceAll("-", "")}`;
  let admin: Kysely<Database>, db: Kysely<Database>;
  let notificationConnectionString: string;
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
    notificationConnectionString = url.toString();
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
      // Kafka is called only after the single admission transaction commits.
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
    const runner = vi.fn(
      async (
        command: ExecuteTurnCommandMessage,
        publish: (event: EventPublishMessage) => Promise<void>,
      ) => {
        await publish({
          protocolVersion: 1,
          messageId: randomUUID(),
          sentAt: new Date().toISOString(),
          type: "event.publish",
          payload: {
            executionReference: command.payload.executionReference,
            event: {
              schemaVersion: 1,
              eventId: randomUUID(),
              sessionId: command.payload.sessionId,
              turnId: command.payload.turnId,
              agentId: "root",
              seq: command.payload.nextEventSeq,
              occurredAt: new Date().toISOString(),
              type: "turn.started",
              payload: { inputKind: "prompt" },
            },
          },
        });
        return { stopReason: "stop" };
      },
    );
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

  it.each([false, true])(
    "notifies seal work only after atomic completion commits (rollback=%s)",
    async (rollback) => {
      const f = await fixture(),
        wake = new PostgresNotificationWake(
          notificationConnectionString,
          TERMINAL_OUTBOX_NOTIFICATION_CHANNEL,
        );
      wake.refresh();
      await vi.waitFor(() => expect(wake.generation).toBeGreaterThan(0));
      const before = wake.generation;
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const statements: string[] = [];
      const measured = db.withPlugin({
        transformQuery({ node, queryId }) {
          statements.push(db.getExecutor().compileQuery(node, queryId).sql);
          return node;
        },
        async transformResult({ result }) {
          return result;
        },
      });
      const executor = new RunExecutor({
        database: measured,
        backend: f.backend,
        claimOwnerId: f.worker,
        executionAuthority: {
          assertCurrent: f.coordinator.assertCurrent.bind(f.coordinator),
          async releaseCurrent(tx, request, reference, now) {
            await f.coordinator.releaseCurrent(tx, request, reference, now);
            entered.resolve();
            await release.promise;
            if (rollback) throw Error("injected settlement rollback");
          },
        },
      });
      const executing = executor.dispatchRun(f.accepted.runId);
      const outcome = Promise.allSettled([executing]);
      try {
        await entered.promise;
        expect(
          await db
            .selectFrom("outbox")
            .select("id")
            .where("tenant_id", "=", f.tenant.tenantId)
            .execute(),
        ).toHaveLength(0);
        expect(wake.generation).toBe(before);
        release.resolve();
        const [result] = await outcome;
        const completion = statements.slice(
          statements.findIndex((s) => s.startsWith('with "completed_turn"')),
        );
        expect(completion.filter((s) => s.startsWith('with "completed_turn"'))).toHaveLength(1);
        expect(completion[0]).toContain('"settled_session"');
        expect(
          completion.filter((s) => s.startsWith('select * from "session_leases"')),
        ).toHaveLength(1);
        expect(completion.filter((s) => s.startsWith('with "queued_seal"'))).toHaveLength(1);
        if (rollback) {
          expect(result).toMatchObject({ status: "rejected" });
          expect(
            await db
              .selectFrom("outbox")
              .select("id")
              .where("tenant_id", "=", f.tenant.tenantId)
              .execute(),
          ).toHaveLength(0);
          expect((await f.state()).leases).toHaveLength(1);
          expect((await f.state()).worker.active_sessions).toBe(1);
          expect(
            (
              await db
                .selectFrom("turns")
                .select("state")
                .where("id", "=", f.accepted.turnId)
                .executeTakeFirstOrThrow()
            ).state,
          ).toBe("running");
          expect(
            (
              await db
                .selectFrom("sessions")
                .select("state")
                .where("id", "=", f.session.sessionId)
                .executeTakeFirstOrThrow()
            ).state,
          ).toBe("running");
          await new Promise((r) => setTimeout(r, 30));
          expect(wake.generation).toBe(before);
        } else {
          expect(result).toMatchObject({ status: "fulfilled", value: { status: "completed" } });
          await vi.waitFor(() => expect(wake.generation).toBe(before + 1));
          expect((await f.state()).leases).toHaveLength(0);
          await f.project();
        }
      } finally {
        release.resolve();
        await outcome;
        await wake.close();
      }
    },
  );

  it("commits once before local execution and never appends an opening handshake", async () => {
    const f = await fixture();
    let transactions = 0;
    const observed = new Proxy(db, {
      get(target, property) {
        if (property === "transaction")
          return () => ({
            execute: (body: (tx: Transaction<Database>) => Promise<unknown>) => {
              transactions++;
              return target.transaction().execute(body);
            },
          });
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const run = f.runner.getMockImplementation()!;
    f.runner.mockImplementation(async (...args) => {
      expect(transactions).toBe(1);
      expect(f.facts).toEqual([]);
      return run(...args);
    });
    expect(await f.executor(f.backend, observed).dispatchRun(f.accepted.runId)).toMatchObject({
      status: "completed",
    });
    expect(transactions).toBe(2); // admission and completion, not another startup transaction
    expect(f.facts.map((fact) => fact.kind)).toEqual(["agent_event"]);
  });

  it.each(["before_write", "after_write"])(
    "anchors a display-only first record before visibility after %s loss",
    async (phase) => {
      const f = await fixture();
      await f.executor().dispatchRun(f.accepted.runId);
      let inject = true;
      const targets = new WeakSet<object>();
      const faulty = db.withPlugin({
        transformQuery({ node, queryId }) {
          const query = db.getExecutor().compileQuery(node, queryId).sql;
          if (
            query.startsWith('update "run_attempts"') &&
            query.includes('"output_first_offset"')
          ) {
            targets.add(queryId);
            if (inject && phase === "before_write") {
              inject = false;
              throw Error("injected write failure");
            }
          }
          return node;
        },
        async transformResult({ result, queryId }) {
          if (inject && phase === "after_write" && targets.has(queryId)) {
            inject = false;
            throw Error("injected lost reply");
          }
          return result;
        },
      });
      const projector = new ExecutionStreamProjector(faulty);
      const record = { fact: f.facts[0]!, topic: `display-${f.worker}`, partition: 0, offset: 10n };
      await expect(projector.project(record)).rejects.toThrow(/injected/);
      const state = await db
        .selectFrom("run_attempts")
        .select("output_first_offset")
        .where("run_id", "=", f.accepted.runId)
        .executeTakeFirstOrThrow();
      expect(state.output_first_offset).toBe(phase === "before_write" ? null : "10");
      await projector.project(record);
      await projector.project({ ...record, offset: 11n });
      expect(
        (
          await db
            .selectFrom("run_attempts")
            .select("output_first_offset")
            .where("run_id", "=", f.accepted.runId)
            .executeTakeFirstOrThrow()
        ).output_first_offset,
      ).toBe("10");
      expect(
        (await loadFactReplayOffsets(db, record.topic, [{ partition: 0, low: 0n, high: 60n }])).get(
          0,
        ),
      ).toBe(0n);
      await db.transaction().execute((tx) => recordFactProjection(tx, { ...record, offset: 50n }));
      expect(
        (await loadFactReplayOffsets(db, record.topic, [{ partition: 0, low: 0n, high: 60n }])).get(
          0,
        ),
      ).toBe(10n);
    },
  );

  it("does not lose a terminal hint delivered during an older empty scan", async () => {
    const f = await fixture(),
      empty = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>(),
      appended: string[] = [];
    const executor = db.getExecutor(),
      original = executor.executeQuery.bind(executor);
    let held = false;
    const notify = vi.spyOn(PostgresNotificationWake.prototype, "notify");
    const relay = new AcceptedFactTerminalOutboxRelay({
      database: db,
      notificationConnectionString,
      pollIntervalMs: 5000,
      bus: {
        checkHealth: async () => {},
        append: async (fact) => {
          appended.push(fact.factId);
          return { factId: fact.factId, durable: true };
        },
      },
    });
    // Other fixtures may retain undispatched seals. Deliver them before holding
    // an empty scan; only this fixture's subsequent hint is under test.
    while (await relay.dispatchOne()) {}
    const gate = vi.spyOn(executor, "executeQuery").mockImplementation(async (...args) => {
      const result = await original(...args);
      if (!held && args[0].sql.includes("update outbox as claimed") && result.rows.length === 0) {
        held = true;
        empty.resolve();
        await release.promise;
      }
      return result;
    });
    try {
      relay.start();
      await empty.promise;
      await vi.waitFor(() => expect(notify).toHaveBeenCalled());
      const count = notify.mock.calls.length;
      await f.executor().dispatchRun(f.accepted.runId);
      await vi.waitFor(() => expect(notify.mock.calls.length).toBeGreaterThan(count));
      release.resolve();
      const seal = (
        await db
          .selectFrom("run_attempts")
          .select("output_seal_id")
          .where("run_id", "=", f.accepted.runId)
          .executeTakeFirstOrThrow()
      ).output_seal_id!;
      await vi.waitFor(() => expect(appended).toContain(seal), { timeout: 1500 });
    } finally {
      release.resolve();
      await relay.close();
      gate.mockRestore();
      notify.mockRestore();
    }
  });

  it("keeps polling during listener loss and reconnects before shutdown", async () => {
    const f = await fixture(),
      appended: string[] = [];
    const relay = new AcceptedFactTerminalOutboxRelay({
      database: db,
      notificationConnectionString,
      pollIntervalMs: 20,
      bus: {
        checkHealth: async () => {},
        append: async (fact) => {
          appended.push(fact.factId);
          return { factId: fact.factId, durable: true };
        },
      },
    });
    const listeners = () =>
      sql<{
        pid: number;
      }>`select pid from pg_stat_activity where datname=${name} and application_name=${TERMINAL_OUTBOX_NOTIFICATION_CHANNEL}`.execute(
        db,
      );
    try {
      relay.start();
      await vi.waitFor(async () => expect((await listeners()).rows).toHaveLength(1));
      const pid = (await listeners()).rows[0]!.pid;
      await sql`select pg_terminate_backend(${pid})`.execute(db);
      await f.executor().dispatchRun(f.accepted.runId);
      const seal = (
        await db
          .selectFrom("run_attempts")
          .select("output_seal_id")
          .where("run_id", "=", f.accepted.runId)
          .executeTakeFirstOrThrow()
      ).output_seal_id!;
      await vi.waitFor(() => expect(appended).toContain(seal), { timeout: 800 });
      await vi.waitFor(
        async () => {
          const rows = (await listeners()).rows;
          expect(rows).toHaveLength(1);
          expect(rows[0]!.pid).not.toBe(pid);
        },
        { timeout: 3000 },
      );
      expect(() => relay.checkHealth()).not.toThrow();
    } finally {
      await relay.close();
    }
    await vi.waitFor(async () => expect((await listeners()).rows).toHaveLength(0));
  });

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
  it("cancellation after admission owns settlement even before the local Runner is prepared", async () => {
    const f = await fixture();
    const cancelling = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    let cancelled!: Promise<unknown>;
    const backend: TurnExecutionBackend = {
      admit: f.backend.admit.bind(f.backend),
      execute: async (r, l, a) => {
        await f.store.acceptTurnCancellation(
          f.session.sessionId,
          f.accepted.turnId,
          randomUUID(),
          {},
        );
        const cancellation = new RunCancellationExecutor({
          database: db,
          executionAuthority: f.coordinator,
          backend: {
            async cancel(_request, lifecycle) {
              await lifecycle.started(a!);
              cancelling.resolve();
              await release.promise;
              return { reason: _request.reason, forced: false };
            },
          },
        });
        cancelled = cancellation.dispatchTargetRun(f.accepted.runId);
        await Promise.race([
          cancelling.promise,
          cancelled.then(() => {
            throw Error("Cancellation failed before admission");
          }),
        ]);
        return f.backend.execute(r, l, a);
      },
    };
    try {
      expect(await f.executor(backend).dispatchRun(f.accepted.runId)).toMatchObject({
        status: "cancellation_pending",
      });
      expect(f.runner).toHaveBeenCalledOnce();
    } finally {
      release.resolve();
    }
    expect(await cancelled).toMatchObject({ status: "cancelled" });
    await f.project();
    expect((await f.state()).run.state).toBe("cancelled");
    const terminals = await db
      .selectFrom("session_terminal_events")
      .select("type")
      .where("run_id", "=", f.accepted.runId)
      .execute();
    expect(terminals).toEqual([{ type: "turn.cancelled" }]);
  });
  it("preparation rejection seals the admitted attempt instead of requeueing it", async () => {
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
      status: "failed",
      phase: "after_admission",
    });
    expect(f.append).not.toHaveBeenCalled();
    expect((await f.state()).leases).toEqual([]);
    expect((await f.state()).worker.active_sessions).toBe(0);
    expect(await f.executor().dispatchRun(f.accepted.runId)).toEqual({ status: "idle" });
    const seal = await db
      .selectFrom("outbox")
      .select("payload")
      .where("tenant_id", "=", f.tenant.tenantId)
      .executeTakeFirstOrThrow();
    expect(seal.payload).toMatchObject({ closesWriter: false }); // known-empty local writer drained
    await f.project();
    const attempt = await db
      .selectFrom("run_attempts")
      .select(["output_first_offset", "output_sealed_at"])
      .where("run_id", "=", f.accepted.runId)
      .executeTakeFirstOrThrow();
    expect(attempt.output_first_offset).toBe("0");
    expect(attempt.output_sealed_at).not.toBeNull();
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
  it("a lost first append ACK fails and seals, without replaying the Agent", async () => {
    const f = await fixture();
    f.append.mockImplementation(async (fact) => {
      f.facts.push(fact);
      throw new Error("lost Kafka ACK");
    });
    expect(await f.executor().dispatchRun(f.accepted.runId)).toMatchObject({
      status: "failed",
      phase: "after_admission",
    });
    expect(f.runner).toHaveBeenCalledOnce();
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
  it("owner loss immediately after admission requires a seal and cannot requeue the Run", async () => {
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
    expect((await f.state()).run.state).toBe("failed");
    expect(await f.executor().dispatchRun(f.accepted.runId)).toEqual({ status: "idle" });
    await f.project();
    expect((await f.state()).attempts).toHaveLength(1);
  });

  it.each(["before_commit", "after_commit"])(
    "co-commits the first native floor and replays after %s failure",
    async (phase) => {
      const f = await fixture();
      expect(await f.executor().dispatchRun(f.accepted.runId)).toMatchObject({
        status: "completed",
      });
      const seq = Number(
        (
          await db
            .selectFrom("pi_sessions")
            .select("next_seq")
            .where("id", "=", f.session.sessionId)
            .executeTakeFirstOrThrow()
        ).next_seq,
      );
      const fact: AcceptedFact = {
        kind: "pi_session_append",
        factId: randomUUID(),
        scope: f.facts[0]!.scope,
        piSession: { id: f.session.sessionId, lane: "main", writerId: f.facts[0]!.scope.writerId },
        items: [{ kind: "fact", fact: "name", seq, name: "first-record-test" }],
        events: [],
        occurredAt: new Date().toISOString(),
      };
      const record = { fact, topic: `first-${f.worker}`, partition: 0, offset: 10n };
      let inject = true;
      const faulty = new Proxy(db, {
        get(target, property) {
          if (property === "transaction")
            return () => ({
              execute: async (callback: (tx: Transaction<Database>) => Promise<unknown>) => {
                const result = await target.transaction().execute(async (tx) => {
                  const result = await callback(tx);
                  if (inject && phase === "before_commit") {
                    inject = false;
                    throw new Error("injected rollback");
                  }
                  return result;
                });
                if (inject && phase === "after_commit") {
                  inject = false;
                  throw new Error("injected lost commit reply");
                }
                return result;
              },
            });
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const projector = new ExecutionStreamProjector(faulty);
      await expect(projector.project(record)).rejects.toThrow(/injected/);
      const floor = await db
        .selectFrom("run_attempts")
        .select("output_first_offset")
        .where("id", "=", fact.scope.attemptId)
        .executeTakeFirstOrThrow();
      expect(floor.output_first_offset).toBe(phase === "before_commit" ? null : "10");
      await projector.project(record);
      expect(
        await db
          .selectFrom("pi_session_log")
          .select("seq")
          .where("append_id", "=", fact.factId)
          .execute(),
      ).toHaveLength(1);
      await db.transaction().execute((tx) => recordFactProjection(tx, { ...record, offset: 50n }));
      expect(
        (await loadFactReplayOffsets(db, record.topic, [{ partition: 0, low: 0n, high: 60n }])).get(
          0,
        ),
      ).toBe(10n);
      expect((await acceptedFactRetentionFloors(db, record.topic, [0])).get(0)).toBe(10n);
      const replay = new ExecutionStreamProjector(db);
      await replay.project(record);
      await expect(
        new ExecutionStreamProjector(db).project({ ...record, offset: 11n }),
      ).rejects.toThrow(/prefix is missing/);
    },
  );
});
