import { kafkaProducerLane } from "../../runtime-core/src/kafka-accepted-fact.ts";
import { ConversationDeletionService } from "../src/conversation-deletion-service.ts";
import { randomUUID } from "node:crypto";
import {
  createDatabase,
  runMigrations,
  PostgresNotificationWake,
  type Database,
} from "@pi-cloud/database";
import { SessionOutboxRelay } from "../../runtime-core/src/session-outbox-relay.ts";
import { SESSION_CONTROL_NOTIFICATION_CHANNEL } from "@pi-cloud/protocol";
import { sql, type Kysely, type Transaction } from "kysely";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { AgentRunSupervisor } from "@pi-cloud/sandbox-supervisor";
import {
  parseExecutionReference,
  type ExecuteTurnCommandMessage,
  type EventPublishMessage,
} from "@pi-cloud/protocol";
import { AgentRunExecutionBackend } from "../../supervisor-host/src/agent-run-execution-backend.ts";
import {
  RunExecutor,
  type TurnExecutionBackend,
  type TurnExecutionRequest,
  type TurnExecutionAdmission,
} from "../../runtime-core/src/run-executor.ts";
import { RunCancellationExecutor } from "../../runtime-core/src/run-cancellation-executor.ts";
import { SessionLeaseCoordinator } from "../../runtime-core/src/session-lease-coordinator.ts";
import { WorkerExecutionLog } from "../../runtime-core/src/worker-execution-log.ts";
import { ExecutionStreamProjector } from "../../runtime-core/src/execution-stream-projection.ts";
import { PostgresDurableCommitProjector } from "../../runtime-core/src/postgres-durable-commit-projector.ts";
import { createExecutionPublication } from "../../runtime-core/src/execution-publication.ts";
import type { AcceptedFact, AcceptedFactBus } from "../../runtime-core/src/accepted-fact.ts";
import {
  loadFactReplayOffsets,
  recordFactProjection,
} from "../../runtime-core/src/accepted-fact-recovery.ts";
import { acceptedFactRetentionFloors } from "../../runtime-core/src/kafka-safe-retention.ts";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { AssignmentReconciler } from "../src/assignment-reconciler.ts";
import { deletePostgresPiSessionsInTransaction } from "@pi-cloud/pi-session-postgres";
import { ConversationReader } from "../src/conversation-reader.ts";
import { projectionTransaction } from "../../runtime-core/src/projection-transaction.ts";

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
  async function fixture(capacity = 2, open?: AcceptedFactBus["open"]) {
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
      })
      .execute();
    const coordinator = new SessionLeaseCoordinator({ database: db, sandboxId: worker });
    const facts: AcceptedFact[] = [];
    const append = vi.fn(async (fact: AcceptedFact) => {
      // Kafka is called only after the single admission transaction commits.
      const a = await db
        .selectFrom("runs")
        .select(["state", "output_publication"])
        .where("id", "=", fact.scope.runId)
        .executeTakeFirstOrThrow();
      expect(["running", "cancel_requested"]).toContain(a.state);
      expect(a.output_publication).not.toBeNull();
      facts.push(fact);
      return { factId: fact.factId, durable: true as const };
    });
    const logs = new WorkerExecutionLog(db, {
      append,
      ...(open ? { open } : {}),
      checkHealth: async () => {},
    });
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
        workerId: worker,
      });
    const accepted = await store.acceptTurn(session.sessionId, randomUUID(), {
      prompt: "atomic test",
    });
    const state = async () => ({
      run: await db
        .selectFrom("runs")
        .select(["state", "lease_id", "output_publication"])
        .where("id", "=", accepted.runId)
        .executeTakeFirstOrThrow(),
      physical: await db
        .selectFrom("pi_sessions")
        .select(["lease_epoch", "unsealed_runs"])
        .where("id", "=", session.sessionId)
        .executeTakeFirstOrThrow(),
      worker: await db
        .selectFrom("sandboxes")
        .select(["state"])
        .where("id", "=", worker)
        .executeTakeFirstOrThrow(),
      leases: await db
        .selectFrom("session_leases")
        .select("lease_id")
        .where("tenant_id", "=", tenant.tenantId)
        .where("released_at", "is", null)
        .execute(),
      admittedRuns: await db
        .selectFrom("runs")
        .select("id")
        .where("tenant_id", "=", tenant.tenantId)
        .where("lease_id", "is not", null)
        .execute(),
    });
    async function project() {
      const projector = new ExecutionStreamProjector(db);
      const seals = await db
        .selectFrom("outbox")
        .where("aggregate_type", "=", "session_terminal_event")
        .select("payload")
        .where("tenant_id", "=", tenant.tenantId)
        .execute();
      let offset = 0n;
      for (const fact of [...facts, ...seals.map((s) => s.payload as unknown as AcceptedFact)]) {
        const record = { fact, topic: `test-${worker}`, partition: 0, offset: offset++ };
        await projector.project(record);
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

  it("leaves unavailable partitions queued without claiming a lease and admits a ready partition", async () => {
    const f = await fixture();
    const own = kafkaProducerLane(f.session.sessionId, 4);
    const before = await f.state();
    const denied = {
      blockedFamilyKeys: [],
      publication: { partitionCount: 4, partitions: [(own + 1) % 4] },
    };
    expect(await f.executor().dispatchRun(f.accepted.runId, denied)).toEqual({ status: "idle" });
    expect(await f.executor().dispatchNext(denied)).toEqual({ status: "idle" });
    expect(await f.state()).toEqual(before);
    expect(f.runner).not.toHaveBeenCalled();
    await f.executor().dispatchRun(f.accepted.runId, {
      ...denied,
      publication: { partitionCount: 4, partitions: [own] },
    });
    expect(f.runner).toHaveBeenCalledOnce();
    await f.project();
  });

  it("matches the Session partition hash for Unicode and every supported partition count", async () => {
    const ids = ["", "a", "会话", "a😀𐐀z", ...Array.from({ length: 32 }, () => randomUUID())];
    for (const id of ids) {
      const { rows } = await sql<{
        hash: string;
      }>`select pi_cloud_session_hash(${id})::text hash`.execute(db);
      for (const count of [1, 2, 3, 32, 63, 1024])
        expect(Number(BigInt(rows[0]!.hash) % BigInt(count))).toBe(kafkaProducerLane(id, count));
    }
  });

  it("bounds native projection and conversation SQL while retaining indexed history branches", async () => {
    const f = await fixture();
    await f.executor().dispatchRun(f.accepted.runId);
    const queries: ReturnType<ReturnType<typeof db.getExecutor>["compileQuery"]>[] = [];
    const pending = new WeakMap<object, (typeof queries)[number]>();
    const measured = db.withPlugin({
      transformQuery({ node, queryId }) {
        pending.set(queryId, db.getExecutor().compileQuery(node, queryId));
        return node;
      },
      async transformResult({ result, queryId }) {
        queries.push(pending.get(queryId)!);
        return result;
      },
    });
    const scope = f.facts[0]!.scope;
    const first: Extract<AcceptedFact, { kind: "durable_commit" }> = {
      kind: "durable_commit",
      factId: randomUUID(),
      scope,
      occurredAt: new Date().toISOString(),
      commit: {
        seq: 1,
        nextId: 3,
        writes: [
          { type: "conversation", value: { id: 1 } },
          { type: "entry", value: { id: 2, conversationId: 1, kind: "test", data: "test" } },
        ],
      },
      origins: [
        { recordId: 2, sessionId: scope.sessionId, runId: scope.runId, turnId: scope.turnId },
      ],
      tools: [],
      cancellations: [],
      events: [],
    };
    const projector = new PostgresDurableCommitProjector(measured);
    await projector.project(first, { topic: f.worker, partition: 0, offset: 10n });
    expect(queries).toHaveLength(10);
    expect(queries[0]!.sql).toContain("set_config('lock_timeout'");
    queries.length = 0;
    await projector.project(
      {
        ...first,
        factId: randomUUID(),
        commit: {
          seq: 2,
          nextId: 4,
          writes: [
            {
              type: "task",
              value: {
                id: 3,
                conversationId: 1,
                kind: "test.task",
                version: 1,
                input: {},
                background: false,
                abortRequested: false,
                state: { status: "pending", checkpoint: { phase: "start" } },
              },
            },
          ],
        },
        origins: [
          { recordId: 3, sessionId: scope.sessionId, runId: scope.runId, turnId: scope.turnId },
        ],
      },
      { topic: f.worker, partition: 0, offset: 11n },
    );
    expect(queries).toHaveLength(10);
    queries.length = 0;
    const view = await new ConversationReader(measured, f.tenant.tenantId).getConversationView(
      f.session.sessionId,
    );
    expect(view.conversation.turns).toHaveLength(1);
    expect(queries.length).toBeLessThanOrEqual(7);
    const native = queries.find((q) => q.sql.includes("union all"))!;
    expect(native).toBeDefined();
    // A small fixture may rationally use sequential scans. Prove both UNION
    // branches can use the existing partial indexes without adding an index.
    await db.transaction().execute(async (tx) => {
      await sql`set local enable_seqscan=off`.execute(tx);
      const plan = await tx.executeQuery({ ...native, sql: `explain (format json) ${native.sql}` });
      const indexes: string[] = [];
      const visit = (node: unknown) => {
        if (!node || typeof node !== "object") return;
        const index = (node as Record<string, unknown>)["Index Name"];
        if (typeof index === "string" && index.startsWith("pi_durable_")) indexes.push(index);
        for (const value of Object.values(node)) visit(value);
      };
      visit(plan.rows);
      expect(indexes.length, JSON.stringify(plan.rows)).toBeGreaterThan(0);
    });
  });

  async function nativeProjectionFixture() {
    const f = await fixture();
    await f.executor().dispatchRun(f.accepted.runId);
    const fact: Extract<AcceptedFact, { kind: "durable_commit" }> = {
      kind: "durable_commit",
      factId: randomUUID(),
      scope: f.facts[0]!.scope,
      occurredAt: new Date().toISOString(),
      commit: { seq: 1, nextId: 2, writes: [{ type: "conversation", value: { id: 1 } }] },
      origins: [],
      tools: [],
      cancellations: [],
      events: [],
    };
    const position = { topic: f.worker, partition: 0, offset: 10n };
    const checkpoint: Extract<AcceptedFact, { kind: "agent_event" }> = {
      ...(f.facts[0]! as Extract<AcceptedFact, { kind: "agent_event" }>),
      nativeSequence: 1,
    };
    const versions = async () =>
      (
        await sql<Record<string, string>>`
      select r.ctid::text as run_tuple,r.xmin::text as run_version,
        r.output_first_offset,r.output_display_seq,r.output_display_native_seq,
        p.ctid::text as progress_tuple,p.xmin::text as progress_version,p.next_offset
      from runs r join accepted_fact_projection_offsets p on p.topic=${position.topic}
        and p.partition=${position.partition} where r.id=${fact.scope.runId}::uuid`.execute(db)
      ).rows[0]!;
    return { ...f, fact, position, checkpoint, versions };
  }

  it("replays native and display progress without rewriting unchanged tuples", async () => {
    const f = await nativeProjectionFixture();
    const projector = new ExecutionStreamProjector(db);
    const record = { ...f.position, fact: f.fact };
    const checkpoint = { ...f.position, offset: 11n, fact: f.checkpoint };
    await projector.project(record);
    expect(await projector.project(checkpoint)).toEqual({ canonicalThroughSequence: 1 });
    const before = await f.versions();
    expect(before).toMatchObject({
      output_display_seq: "1",
      output_display_native_seq: "1",
      next_offset: "11",
    });
    // Rebuild an owner's disposable view and replay overlapping older offsets.
    const replacement = new ExecutionStreamProjector(db);
    await replacement.project(record);
    expect(await replacement.project(checkpoint)).toEqual({ canonicalThroughSequence: 1 });
    await db.transaction().execute((tx) => recordFactProjection(tx, { ...f.position, offset: 9n }));
    expect(await f.versions()).toEqual(before);
    await expect(
      new PostgresDurableCommitProjector(db).project(
        {
          ...f.fact,
          commit: { ...f.fact.commit, nextId: 3 },
        },
        f.position,
      ),
    ).rejects.toThrow("Native commit position changed bytes");
    expect(await f.versions()).toEqual(before);

    const second = { ...f.fact, factId: randomUUID(), commit: { seq: 2, nextId: 2, writes: [] } };
    await projector.project({ ...f.position, offset: 12n, fact: second });
    expect(await f.versions()).toMatchObject({
      run_tuple: before.run_tuple,
      run_version: before.run_version,
    });
    // Either field can advance; neither may regress when the other moves ahead.
    await projector.project({
      ...checkpoint,
      offset: 13n,
      fact: { ...f.checkpoint, nativeSequence: 2 },
    });
    const advanced = {
      ...f.checkpoint,
      event: { ...f.checkpoint.event, eventId: randomUUID(), seq: 2 },
    };
    await projector.project({ ...checkpoint, offset: 14n, fact: advanced });
    const after = await f.versions();
    expect(after).toMatchObject({
      output_first_offset: "10",
      output_display_seq: "2",
      output_display_native_seq: "2",
      next_offset: "13",
    });
    await projector.project(checkpoint);
    expect(await f.versions()).toEqual(after);
  });

  it("does not accept already-covered display replay without its native commit", async () => {
    const f = await nativeProjectionFixture();
    const projector = new ExecutionStreamProjector(db);
    await projector.project({ ...f.position, fact: f.fact });
    await db
      .updateTable("runs")
      .set({ output_display_seq: "100", output_display_native_seq: "100" })
      .where("id", "=", f.accepted.runId)
      .execute();
    const before = await f.versions();
    await expect(
      projector.project({
        ...f.position,
        offset: 11n,
        fact: { ...f.checkpoint, nativeSequence: 99 },
      }),
    ).rejects.toThrow("Display checkpoint preceded its native commit");
    expect(await f.versions()).toEqual(before);
  });

  it.each(["run", "writer"] as const)(
    "rechecks the %s cutoff after waiting for its authority lock",
    async (boundary) => {
      const f = await nativeProjectionFixture();
      const held = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const holder = db.transaction().execute(async (tx) => {
        if (boundary === "run")
          await tx
            .updateTable("runs")
            .set({ output_sealed_at: new Date(), output_seal_offset: "9" })
            .where("id", "=", f.accepted.runId)
            .execute();
        else
          await tx
            .updateTable("session_leases")
            .set({ writer_sealed_at: new Date(), writer_seal_offset: "9" })
            .where("lease_id", "=", f.fact.scope.writerId)
            .execute();
        held.resolve();
        await release.promise;
      });
      void holder.catch(held.reject);
      let projection: Promise<void> | undefined;
      try {
        await held.promise;
        const started = Promise.withResolvers<number>();
        projection = db.connection().execute(async (connection) => {
          const pid = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(
            connection,
          );
          started.resolve(pid.rows[0]!.pid);
          await new PostgresDurableCommitProjector(connection).project(f.fact, f.position);
        });
        void projection.catch(started.reject);
        const pid = await started.promise;
        await vi.waitFor(async () => {
          const waiting = await sql<{ waiting: boolean }>`select wait_event_type='Lock' as waiting
            from pg_stat_activity where pid=${pid}`.execute(db);
          expect(waiting.rows[0]?.waiting).toBe(true);
        });
        if (boundary === "run")
          // A blocked Run read must not acquire the shared writer first.
          await db.transaction().execute((tx) =>
            sql`select lease_id from session_leases
            where lease_id=${f.fact.scope.writerId}::uuid for no key update nowait`.execute(tx),
          );
        release.resolve();
        await holder;
        await projection;
        expect(
          (
            await sql`select seq from pi_durable_commits
          where session_id=${f.fact.scope.piSessionId}`.execute(db)
          ).rows,
        ).toEqual([]);
        expect(
          (
            await db
              .selectFrom("runs")
              .select("output_first_offset")
              .where("id", "=", f.accepted.runId)
              .executeTakeFirstOrThrow()
          ).output_first_offset,
        ).toBeNull();
        expect(
          await db
            .selectFrom("accepted_fact_projection_offsets")
            .selectAll()
            .where("topic", "=", f.position.topic)
            .execute(),
        ).toEqual([]);
      } finally {
        release.resolve();
        await Promise.allSettled([holder, ...(projection ? [projection] : [])]);
      }
    },
  );

  it("keeps concurrent higher display coverage without rewriting it after a lock wait", async () => {
    const f = await nativeProjectionFixture();
    const projector = new ExecutionStreamProjector(db);
    await projector.project({ ...f.position, fact: f.fact });
    const held = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const holder = db.transaction().execute(async (tx) => {
      await tx
        .updateTable("runs")
        .set({ output_display_seq: "10", output_display_native_seq: "1" })
        .where("id", "=", f.accepted.runId)
        .execute();
      const row = await sql`select ctid::text as tuple,xmin::text as version from runs
        where id=${f.accepted.runId}::uuid`.execute(tx);
      held.resolve();
      await release.promise;
      return row.rows;
    });
    void holder.catch(held.reject);
    let projection: ReturnType<ExecutionStreamProjector["project"]> | undefined;
    try {
      await held.promise;
      projection = projector.project({ ...f.position, offset: 11n, fact: f.checkpoint });
      void projection.catch(held.reject);
      await vi.waitFor(async () => {
        const locks = await sql<{ n: number }>`select count(*)::int n from pg_stat_activity
          where datname=${name} and wait_event_type='Lock'`.execute(db);
        expect(locks.rows[0]!.n).toBeGreaterThan(0);
      });
      release.resolve();
      const before = await holder;
      expect(await projection).toEqual({ canonicalThroughSequence: 1 });
      expect(
        (
          await sql`select ctid::text as tuple,xmin::text as version from runs
        where id=${f.accepted.runId}::uuid`.execute(db)
        ).rows,
      ).toEqual(before);
      expect(await f.versions()).toMatchObject({
        output_display_seq: "10",
        output_display_native_seq: "1",
      });
    } finally {
      release.resolve();
      await Promise.allSettled([holder, ...(projection ? [projection] : [])]);
    }
  });

  it("rolls back a timed-out native Session lock and replays the same offset once", async () => {
    const f = await fixture();
    await f.executor().dispatchRun(f.accepted.runId);
    const scope = f.facts[0]!.scope;
    const fact: Extract<AcceptedFact, { kind: "durable_commit" }> = {
      kind: "durable_commit",
      factId: randomUUID(),
      scope,
      occurredAt: new Date().toISOString(),
      commit: { seq: 1, nextId: 2, writes: [{ type: "conversation", value: { id: 1 } }] },
      origins: [],
      tools: [],
      cancellations: [],
      events: [],
    };
    const position = { topic: f.worker, partition: 0, offset: 10n };
    const locked = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const holder = db.transaction().execute(async (tx) => {
      await tx
        .selectFrom("pi_sessions")
        .select("id")
        .where("id", "=", scope.piSessionId)
        .forUpdate()
        .execute();
      locked.resolve();
      await release.promise;
    });
    void holder.catch(locked.reject);
    try {
      await locked.promise;
      const projector = new PostgresDurableCommitProjector(db, {
        lockTimeoutMs: 50,
        statementTimeoutMs: 500,
      });
      await expect(projector.project(fact, position)).rejects.toMatchObject({ code: "55P03" });
      expect(
        (
          await sql<{
            seq: string;
          }>`select seq from pi_durable_commits where tenant_id=${fact.scope.tenantId}::uuid and session_id=${fact.scope.piSessionId} and seq=${fact.commit.seq}`.execute(
            db,
          )
        ).rows,
      ).toEqual([]);
      expect(
        await db
          .selectFrom("runs")
          .select("output_first_offset")
          .where("id", "=", scope.runId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ output_first_offset: null });
      expect(
        await db
          .selectFrom("accepted_fact_projection_offsets")
          .selectAll()
          .where("topic", "=", position.topic)
          .execute(),
      ).toEqual([]);
    } finally {
      release.resolve();
      await holder;
    }
    const projector = new PostgresDurableCommitProjector(db);
    await projector.project(fact, position);
    await projector.project(fact, position);
    expect(
      (
        await sql<{
          seq: string;
        }>`select seq from pi_durable_commits where tenant_id=${fact.scope.tenantId}::uuid and session_id=${fact.scope.piSessionId} and seq=${fact.commit.seq}`.execute(
          db,
        )
      ).rows,
    ).toEqual([{ seq: "1" }]);
    expect(
      await db
        .selectFrom("accepted_fact_projection_offsets")
        .select("next_offset")
        .where("topic", "=", position.topic)
        .executeTakeFirstOrThrow(),
    ).toEqual({ next_offset: "11" });
  });

  it("cancels long projection statements on the server and restores transaction settings", async () => {
    const f = await fixture();
    await db.connection().execute(async (connection) => {
      const settings = () =>
        sql`select current_setting('lock_timeout') as lock, current_setting('statement_timeout') as statement`.execute(
          connection,
        );
      const before = (await settings()).rows;
      await expect(
        projectionTransaction(
          connection,
          async (tx) => {
            await tx
              .updateTable("pi_sessions")
              .set({ name: "must-rollback" })
              .where("id", "=", f.session.sessionId)
              .execute();
            await sql`select pg_sleep(1)`.execute(tx);
          },
          { lockTimeoutMs: 20, statementTimeoutMs: 60 },
        ),
      ).rejects.toMatchObject({ code: "57014" });
      expect((await settings()).rows).toEqual(before);
      const row = await connection
        .selectFrom("pi_sessions")
        .select("name")
        .where("id", "=", f.session.sessionId)
        .executeTakeFirstOrThrow();
      expect(row.name).not.toBe("must-rollback");
    });
  });

  it("deletes retired owner evidence only with quiescent native history", async () => {
    const f = await nativeProjectionFixture();
    const remove = () =>
      db
        .transaction()
        .execute((tx) =>
          deletePostgresPiSessionsInTransaction(tx, f.tenant.tenantId, [f.session.sessionId]),
        );
    await expect(remove()).rejects.toThrow("must settle before deletion");
    await f.project();
    await expect(remove()).rejects.toThrow("still has a product reference");
    const deletion = new ConversationDeletionService({ database: db });
    await deletion.delete(f.tenant.tenantId, f.session.sessionId);
    await deletion.delete(f.tenant.tenantId, f.session.sessionId);
    await new PostgresDurableCommitProjector(db).project(f.fact, f.position);
    expect(
      await db
        .selectFrom("accepted_fact_projection_offsets")
        .selectAll()
        .where("topic", "=", f.position.topic)
        .execute(),
    ).toEqual([]);
    expect(
      await db
        .selectFrom("session_leases")
        .selectAll()
        .where("tenant_id", "=", f.tenant.tenantId)
        .execute(),
    ).toEqual([]);
    expect(
      await db
        .selectFrom("pi_sessions")
        .select("id")
        .where("id", "=", f.session.sessionId)
        .executeTakeFirst(),
    ).toBeUndefined();
  });
  it("readies only the Lane head and promotes its successor with the committed seal", async () => {
    const f = await fixture();
    const second = await f.store.acceptTurn(f.session.sessionId, randomUUID(), {
      prompt: "second",
    });
    const third = await f.store.acceptTurn(f.session.sessionId, randomUUID(), { prompt: "third" });
    const ready = async () =>
      (
        await db
          .selectFrom("runs")
          .select(["id", "ready_at"])
          .where("session_id", "=", f.session.sessionId)
          .orderBy("mailbox_position")
          .execute()
      )
        .filter((r) => r.ready_at !== null)
        .map((r) => r.id);
    const count = async () =>
      (
        await db
          .selectFrom("pi_sessions")
          .select("unsealed_runs")
          .where("tenant_id", "=", f.tenant.tenantId)
          .where("id", "=", f.session.sessionId)
          .executeTakeFirstOrThrow()
      ).unsealed_runs;
    expect(await ready()).toEqual([f.accepted.runId]);
    expect(await count()).toBe("0");
    expect(await f.executor().dispatchRun(f.accepted.runId)).toMatchObject({ status: "completed" });
    expect(await ready()).toEqual([]);
    expect(await count()).toBe("1");
    expect(await f.executor().dispatchRun(second.runId)).toEqual({ status: "idle" });
    await f.project();
    expect(await count()).toBe("0");
    expect(await ready()).toEqual([second.runId]);
    expect(await f.executor().dispatchRun(third.runId)).toEqual({ status: "idle" });
    expect(await f.executor().dispatchRun(second.runId)).toMatchObject({ status: "completed" });
    expect(await ready()).toEqual([]);
    expect(await count()).toBe("1");
  });

  it("bounds normal input and admission SQL without a second authority read", async () => {
    const f = await fixture();
    let capture = true;
    const queries: string[] = [];
    const statements = new WeakMap<object, string>();
    const measured = db.withPlugin({
      transformQuery({ node, queryId }) {
        statements.set(queryId, db.getExecutor().compileQuery(node, queryId).sql);
        return node;
      },
      async transformResult({ result, queryId }) {
        // CTE builders also transform nodes; only completed top-level queries
        // represent database exchanges.
        if (capture) queries.push(statements.get(queryId)!);
        return result;
      },
    });
    const store = new ControlPlaneStore({ database: measured, ...f.tenant });
    await store.acceptTurn(f.session.sessionId, randomUUID(), { prompt: "follow-up" });
    // The driver adds BEGIN/COMMIT outside Kysely's query-plugin callbacks.
    // ADR-0215 removes the queue-count query; Session ordering still holds its lock.
    expect(queries).toHaveLength(5);
    expect(
      queries.filter((q) => q.startsWith('select count(*)::int as "count" from "runs"')),
    ).toHaveLength(0);
    expect(queries.filter((q) => q.startsWith('with "accepted_run"'))).toHaveLength(1);
    queries.length = 0;
    const backend: TurnExecutionBackend = {
      admit: f.backend.admit.bind(f.backend),
      async execute(request, lifecycle, admission) {
        capture = false;
        return f.backend.execute(request, lifecycle, admission);
      },
    };
    expect(await f.executor(backend, measured).dispatchRun(f.accepted.runId)).toMatchObject({
      status: "completed",
    });
    // The post-lock input snapshot prevents admission from reading a stale edit.
    expect(queries).toHaveLength(9);
    expect(
      queries.filter((q) => q.startsWith('select "input_text", "input_uploads" from "runs"')),
    ).toHaveLength(1);
    expect(queries.some((q) => q.includes('update "sandboxes"'))).toBe(false);
    expect(queries.some((q) => q.includes("from runs as earlier_run"))).toBe(false);
    expect(
      queries.filter(
        (q) =>
          (q.includes('from "pi_sessions"') || q.includes("from pi_sessions")) &&
          q.startsWith("select "),
      ),
    ).toHaveLength(1);
    await f.project();
  });

  it.each(["unchanged", "upgrade"])(
    "does not serialize ordinary environment readers or deadlock a version writer (%s)",
    async (mode) => {
      const f = await fixture();
      const sibling = await f.store.createSession(
        f.workspace.projectId,
        f.workspace.workspaceId,
        "parallel",
        "elastic",
      );
      const held = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const sharedQueries = new WeakSet<object>();
      const measured = db.withPlugin({
        transformQuery({ node, queryId }) {
          const q = db.getExecutor().compileQuery(node, queryId).sql;
          if (q.includes('from "environment_versions"') && q.includes("for share"))
            sharedQueries.add(queryId);
          return node;
        },
        async transformResult({ result, queryId }) {
          if (sharedQueries.has(queryId)) {
            held.resolve();
            await release.promise;
          }
          return result;
        },
      });
      const first = new ControlPlaneStore({ database: measured, ...f.tenant }).acceptTurn(
        f.session.sessionId,
        randomUUID(),
        { prompt: "first" },
      );
      void first.catch(held.reject);
      let second: ReturnType<ControlPlaneStore["acceptTurn"]> | undefined;
      try {
        await held.promise;
        second = new ControlPlaneStore({
          database: db,
          ...f.tenant,
          ...(mode === "upgrade" ? { environmentImageRevision: "next-image" } : {}),
        }).acceptTurn(sibling.sessionId, randomUUID(), { prompt: "second" });
        if (mode === "unchanged") {
          let finished = false;
          void second.then(
            () => {
              finished = true;
            },
            () => {},
          );
          await vi.waitFor(() => expect(finished).toBe(true), { timeout: 2000 });
        } else {
          await vi.waitFor(async () => {
            const { rows } = await sql<{ n: number }>`select count(*)::int n from pg_stat_activity
            where datname=${name} and wait_event_type='Lock'`.execute(admin);
            expect(rows[0]!.n).toBeGreaterThan(0);
          });
        }
        release.resolve();
        const [a, b] = await Promise.all([first, second]);
        const rows = await db
          .selectFrom("runs")
          .innerJoin("environment_versions as e", "e.id", "runs.environment_version_id")
          .select(["runs.id", "e.image_revision"])
          .where("runs.id", "in", [a.runId, b.runId])
          .execute();
        expect(rows.find((r) => r.id === a.runId)?.image_revision).toBe(
          f.workspace.environment.imageRevision,
        );
        expect(rows.find((r) => r.id === b.runId)?.image_revision).toBe(
          mode === "upgrade" ? "next-image" : f.workspace.environment.imageRevision,
        );
      } finally {
        release.resolve();
        await Promise.allSettled([first, ...(second ? [second] : [])]);
      }
    },
  );

  it("publishes one new environment version for competing input requests", async () => {
    const f = await fixture();
    const sibling = await f.store.createSession(
      f.workspace.projectId,
      f.workspace.workspaceId,
      "second",
      "elastic",
    );
    const store = new ControlPlaneStore({
      database: db,
      ...f.tenant,
      environmentImageRevision: "updated-image",
    });
    const accepted = await Promise.all(
      [f.session.sessionId, sibling.sessionId].map((id) =>
        store.acceptTurn(id, randomUUID(), { prompt: "new version" }),
      ),
    );
    const rows = await db
      .selectFrom("runs")
      .select("environment_version_id")
      .where(
        "id",
        "in",
        accepted.map((a) => a.runId),
      )
      .execute();
    expect(new Set(rows.map((r) => r.environment_version_id)).size).toBe(1);
    expect(
      await db
        .selectFrom("environment_versions")
        .select("id")
        .where("project_id", "=", f.workspace.projectId)
        .where("image_revision", "=", "updated-image")
        .execute(),
    ).toHaveLength(1);
  });

  it.each(["input-first", "seal-first"])(
    "does not lose readiness when acceptance races closure: %s",
    async (order) => {
      const f = await fixture();
      await f.executor().dispatchRun(f.accepted.runId);
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const held = new WeakSet<object>();
      let pause = true;
      const measured = db.withPlugin({
        transformQuery({ node, queryId }) {
          const query = db.getExecutor().compileQuery(node, queryId).sql;
          if (
            pause &&
            (order === "input-first"
              ? query.startsWith('with "accepted_run"')
              : query.startsWith('update "sessions"') && query.includes('"next_event_seq"'))
          ) {
            pause = false;
            held.add(queryId);
          }
          return node;
        },
        async transformResult({ result, queryId }) {
          if (held.has(queryId)) {
            entered.resolve();
            await release.promise;
          }
          return result;
        },
      });
      const projector = new ExecutionStreamProjector(order === "seal-first" ? measured : db);
      for (const [i, fact] of f.facts.entries())
        await projector.project({ fact, topic: "ready-race", partition: 0, offset: BigInt(i) });
      const row = await db
        .selectFrom("outbox")
        .where("aggregate_type", "=", "session_terminal_event")
        .select("payload")
        .where("tenant_id", "=", f.tenant.tenantId)
        .executeTakeFirstOrThrow();
      const seal = () =>
        projector.project({
          fact: row.payload as unknown as AcceptedFact,
          topic: "ready-race",
          partition: 0,
          offset: BigInt(f.facts.length),
        });
      const store = new ControlPlaneStore({
        database: order === "input-first" ? measured : db,
        ...f.tenant,
      });
      const input = () =>
        store.acceptTurn(f.session.sessionId, randomUUID(), { prompt: "racing follow-up" });
      const first = order === "input-first" ? input() : seal();
      await entered.promise;
      const second = order === "input-first" ? seal() : input();
      try {
        await vi.waitFor(async () => {
          const locks = await sql<{ n: number }>`select count(*)::int n from pg_stat_activity
          where datname=${name} and wait_event_type='Lock'`.execute(db);
          expect(locks.rows[0]!.n).toBeGreaterThan(0);
        });
      } finally {
        release.resolve();
      }
      await Promise.all([first, second]);
      const queued = await db
        .selectFrom("runs")
        .select(["id", "ready_at"])
        .where("session_id", "=", f.session.sessionId)
        .where("state", "=", "queued")
        .execute();
      expect(queued).toHaveLength(1);
      expect(queued[0]!.ready_at).toBeInstanceOf(Date);
      expect(await f.executor().dispatchRun(queued[0]!.id)).toMatchObject({ status: "completed" });
    },
  );

  it("rolls readiness and family closure back together and ignores duplicate seals", async () => {
    const f = await fixture();
    const second = await f.store.acceptTurn(f.session.sessionId, randomUUID(), { prompt: "after" });
    await f.executor().dispatchRun(f.accepted.runId);
    let fail = true;
    const measured = db.withPlugin({
      transformQuery({ node, queryId }) {
        if (
          fail &&
          db.getExecutor().compileQuery(node, queryId).sql.startsWith("update runs candidate")
        )
          throw new Error("readiness rollback");
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    const projector = new ExecutionStreamProjector(measured);
    for (const [i, fact] of f.facts.entries())
      await projector.project({ fact, topic: "ready-rollback", partition: 0, offset: BigInt(i) });
    const row = await db
      .selectFrom("outbox")
      .where("aggregate_type", "=", "session_terminal_event")
      .select("payload")
      .where("tenant_id", "=", f.tenant.tenantId)
      .executeTakeFirstOrThrow();
    const record = {
      fact: row.payload as unknown as AcceptedFact,
      topic: "ready-rollback",
      partition: 0,
      offset: BigInt(f.facts.length),
    };
    const snapshot = async () => ({
      family: await db
        .selectFrom("pi_sessions")
        .select("unsealed_runs")
        .where("tenant_id", "=", f.tenant.tenantId)
        .where("id", "=", f.session.sessionId)
        .executeTakeFirstOrThrow(),
      next: await db
        .selectFrom("runs")
        .select("ready_at")
        .where("id", "=", second.runId)
        .executeTakeFirstOrThrow(),
    });
    const before = await snapshot();
    await expect(projector.project(record)).rejects.toThrow("readiness rollback");
    expect(await snapshot()).toEqual(before);
    fail = false;
    await projector.project(record);
    const after = await snapshot();
    expect(after.family.unsealed_runs).toBe("0");
    expect(after.next.ready_at).toBeInstanceOf(Date);
    await projector.project(record);
    expect(await snapshot()).toEqual(after);
  });

  it.each([false, true])(
    "notifies seal work only after atomic completion commits (rollback=%s)",
    async (rollback) => {
      const f = await fixture(),
        wake = new PostgresNotificationWake(
          notificationConnectionString,
          SESSION_CONTROL_NOTIFICATION_CHANNEL,
        );
      wake.refresh();
      await vi.waitFor(() => expect(wake.generation).toBeGreaterThan(0));
      let before = wake.generation;
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
        workerId: f.worker,
        executionAuthority: {
          assertCurrent: f.coordinator.assertCurrent.bind(f.coordinator),
          assertCurrentOrExpired: f.coordinator.assertCurrentOrExpired.bind(f.coordinator),
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
        // Admission now emits queue-view hints on the shared control channel.
        // Drain those committed notifications before testing the held settlement.
        const admissionGeneration = wake.generation;
        await sql`select pg_notify(${SESSION_CONTROL_NOTIFICATION_CHANNEL}, 'settlement-test-barrier')`.execute(
          db,
        );
        await vi.waitFor(() => expect(wake.generation).toBeGreaterThan(admissionGeneration));
        before = wake.generation;
        expect(
          await db
            .selectFrom("outbox")
            .where("aggregate_type", "=", "session_terminal_event")
            .select("id")
            .where("tenant_id", "=", f.tenant.tenantId)
            .execute(),
        ).toHaveLength(0);
        expect(wake.generation).toBe(before);
        release.resolve();
        const [result] = await outcome;
        const completion = statements.slice(
          statements.findIndex((s) => s.startsWith('with "settled_session"')),
        );
        expect(completion.filter((s) => s.startsWith('with "settled_session"'))).toHaveLength(1);
        expect(completion[0]).toContain('"settled_session"');
        expect(
          completion.filter((s) =>
            s.startsWith('select "tenant_id", "pi_session_id" from "session_leases"'),
          ),
        ).toHaveLength(1);
        expect(completion.filter((s) => s.startsWith('with "queued_seal"'))).toHaveLength(1);
        if (rollback) {
          expect(result).toMatchObject({ status: "rejected" });
          expect(
            await db
              .selectFrom("outbox")
              .where("aggregate_type", "=", "session_terminal_event")
              .select("id")
              .where("tenant_id", "=", f.tenant.tenantId)
              .execute(),
          ).toHaveLength(0);
          expect((await f.state()).leases).toHaveLength(1);
          expect((await f.state()).worker.state).toBe("ready");
          expect(
            (
              await db
                .selectFrom("runs")
                .select("state")
                .where("turn_id", "=", f.accepted.turnId)
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
          if (query.startsWith('update "runs"') && query.includes('"output_first_offset"')) {
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
        .selectFrom("runs")
        .select("output_first_offset")
        .where("id", "=", f.accepted.runId)
        .executeTakeFirstOrThrow();
      expect(state.output_first_offset).toBe(phase === "before_write" ? null : "10");
      await projector.project(record);
      await projector.project({ ...record, offset: 11n });
      expect(
        (
          await db
            .selectFrom("runs")
            .select("output_first_offset")
            .where("id", "=", f.accepted.runId)
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
    const relay = new SessionOutboxRelay({
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
          .selectFrom("runs")
          .select("output_seal_id")
          .where("id", "=", f.accepted.runId)
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
    const relay = new SessionOutboxRelay({
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
      }>`select pid from pg_stat_activity where datname=${name} and application_name=${SESSION_CONTROL_NOTIFICATION_CHANNEL}`.execute(
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
          .selectFrom("runs")
          .select("output_seal_id")
          .where("id", "=", f.accepted.runId)
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
        admit: async (tx, r, mark, facts) => {
          const a = await f.backend.admit(tx, r, mark, facts);
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
      expect(s.admittedRuns).toEqual([]);
      expect(s.leases).toEqual([]);
      expect(s.worker.state).toBe("ready");
      expect(f.append).not.toHaveBeenCalled();
      expect(f.runner).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    expect(await pending).toMatchObject({ status: "completed" });
    expect(f.runner).toHaveBeenCalledOnce();
    const a = await db
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", f.accepted.runId)
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
        admit: async (tx, r, mark, facts) => {
          if (stage === "lease") await f.coordinator.acquireInTransaction(tx, r, facts, mark);
          else await f.backend.admit(tx, r, mark, facts);
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
      });
    },
  );
  it("rejects an expired owner at the final Run write without starting the Agent", async () => {
    const f = await fixture(),
      before = await f.state();
    await expect(
      f
        .executor({
          async admit(tx, r, mark, facts) {
            const admitted = await f.backend.admit(tx, r, mark, facts);
            const ref = parseExecutionReference(admitted.executionReference);
            await tx
              .updateTable("session_leases")
              .set({
                acquired_at: sql<Date>`clock_timestamp()-interval '2 seconds'`,
                valid_until: sql<Date>`clock_timestamp()-interval '1 second'`,
              })
              .where("lease_id", "=", ref.leaseId)
              .execute();
            return admitted;
          },
          execute: f.backend.execute.bind(f.backend),
        })
        .dispatchRun(f.accepted.runId),
    ).rejects.toThrow("Execution admission did not start exactly one task");
    expect(await f.state()).toEqual(before);
    expect(f.runner).not.toHaveBeenCalled();
    expect(f.append).not.toHaveBeenCalled();
  });
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
      admit: async (tx, request, mark, facts) => {
        const bound = await f.coordinator.acquireInTransaction(tx, request, facts, mark);
        if (fault === "failed_writer" || fault === "sealed_writer")
          await tx
            .updateTable("session_leases")
            .set(
              fault === "failed_writer"
                ? { writer_failed_at: new Date() }
                : { writer_sealed_at: new Date() },
            )
            .where("lease_id", "=", parseExecutionReference(bound.executionReference).leaseId)
            .execute();
        const publication = createExecutionPublication({
          ...bound,
          tenantId: request.tenantId,
          runId: request.runId,
          sessionId: fault === "wrong_session" ? randomUUID() : request.sessionId,
          turnId: fault === "wrong_turn" ? randomUUID() : request.turnId,
          nextEventSeq: Number(request.nextEventSeq),
          piSession: {
            id: fault === "wrong_physical_session" ? randomUUID() : request.piSessionId,
            conversationId: fault === "wrong_lane" ? 999 : request.piConversationId,
            writerId:
              fault === "wrong_writer"
                ? randomUUID()
                : parseExecutionReference(bound.executionReference).leaseId,
          },
        });
        return { ...bound, publication };
      },
      execute: f.backend.execute.bind(f.backend),
    };
    await expect(f.executor(backend).dispatchRun(f.accepted.runId)).rejects.toThrow();
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
    });
    expect(f.runner).toHaveBeenCalledOnce();
    expect((await f.state()).admittedRuns).toHaveLength(1);
  });
  it("a connection lost before COMMIT leaves accepted input queued and no admission", async () => {
    const f = await fixture();
    const before = await f.state();
    const backend: TurnExecutionBackend = {
      admit: async (tx, request, mark, facts) => {
        const admitted = await f.backend.admit(tx, request, mark, facts);
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
    });
  });
  it("retries a database-certified admission abort without publishing or consuming an Attempt", async () => {
    const f = await fixture();
    let attempts = 0;
    const backend: TurnExecutionBackend = {
      admit: async (tx, r, mark, facts) => {
        const a = await f.backend.admit(tx, r, mark, facts);
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
    });
    expect(attempts).toBe(2);
    expect(f.runner).toHaveBeenCalledOnce();
    expect((await f.state()).admittedRuns).toHaveLength(1);
  });
  it("cancels a pending publication admission without ever starting the Runner", async () => {
    const entered = Promise.withResolvers<void>();
    const f = await fixture(2, async (_permit, signal) => {
      entered.resolve();
      await new Promise<void>((_resolve, reject) => {
        signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
      });
    });
    const executing = f.executor().dispatchRun(f.accepted.runId);
    await entered.promise;
    await f.store.acceptTurnCancellation(f.session.sessionId, f.accepted.turnId, randomUUID(), {});
    const cancellation = new RunCancellationExecutor({
      database: db,
      executionAuthority: f.coordinator,
      backend: f.backend,
    });
    expect(await cancellation.dispatchTargetRun(f.accepted.runId)).toMatchObject({
      status: "cancelled",
      forced: false,
    });
    await executing;
    expect(f.runner).not.toHaveBeenCalled();
    expect(f.facts).toEqual([]);
    expect((await f.state()).run.state).toBe("cancelled");
    const seal = await db
      .selectFrom("outbox")
      .where("aggregate_type", "=", "session_terminal_event")
      .select("payload")
      .where("tenant_id", "=", f.tenant.tenantId)
      .executeTakeFirstOrThrow();
    expect(seal.payload).toMatchObject({ closesWriter: false });
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
  it.each([false, true])(
    "settles cancellation beside native projection without replaying stop (SQL abort=%s)",
    async (injectAbort) => {
      const f = await fixture();
      const started = Promise.withResolvers<{
        request: TurnExecutionRequest;
        admission: TurnExecutionAdmission;
      }>();
      const finish = Promise.withResolvers<void>(),
        nativeLocked = Promise.withResolvers<void>(),
        releaseNative = Promise.withResolvers<void>();
      const executing = f
        .executor({
          admit: f.backend.admit.bind(f.backend),
          async execute(request, lifecycle, admission) {
            started.resolve({ request, admission: admission! });
            await finish.promise;
            lifecycle.executionExited();
            return { stopReason: "stop" };
          },
        })
        .dispatchRun(f.accepted.runId);
      const { request, admission } = await Promise.race([
        started.promise,
        executing.then((result) => {
          throw new Error(`Run did not enter execution: ${JSON.stringify(result)}`);
        }),
      ]);
      const { leaseId: _lease, piConversationId: _lane, ...scope } = admission.publication.scope;
      const fact: Extract<AcceptedFact, { kind: "durable_commit" }> = {
        kind: "durable_commit",
        factId: randomUUID(),
        scope,
        occurredAt: new Date().toISOString(),
        commit: { seq: 1, nextId: 2, writes: [{ type: "conversation", value: { id: 1 } }] },
        origins: [],
        tools: [],
        cancellations: [],
        events: [],
      };
      const selected = new WeakSet<object>();
      const measured = db.withPlugin({
        transformQuery({ node, queryId }) {
          const q = db.getExecutor().compileQuery(node, queryId).sql;
          if (
            q.startsWith("select ") &&
            (q.includes('from "pi_sessions"') || q.includes("from pi_sessions"))
          )
            selected.add(queryId);
          return node;
        },
        async transformResult({ result, queryId }) {
          if (selected.has(queryId)) {
            nativeLocked.resolve();
            await releaseNative.promise;
          }
          return result;
        },
      });
      let projection: Promise<void> | undefined,
        effects = 0,
        stopped = false,
        settlementAttempts = 0;
      const cancellationDb = db.withPlugin({
        transformQuery({ node, queryId }) {
          if (
            stopped &&
            db.getExecutor().compileQuery(node, queryId).sql.includes('"controlAttempts"')
          )
            settlementAttempts++;
          return node;
        },
        async transformResult({ result }) {
          return result;
        },
      });
      if (injectAbort)
        await sql`create sequence cancellation_abort_once;
      create function abort_first_cancellation() returns trigger language plpgsql as $$
      begin
        if nextval('cancellation_abort_once')=1 then
          raise exception 'certified cancellation rollback' using errcode='40001';
        end if;
        return new;
      end $$;
      create trigger abort_first_cancellation before insert on run_transitions
        for each row when(new.to_state='cancelled') execute function abort_first_cancellation();`.execute(
          db,
        );
      await f.store.acceptTurnCancellation(
        f.session.sessionId,
        f.accepted.turnId,
        randomUUID(),
        {},
      );
      const cancelled = new RunCancellationExecutor({
        database: cancellationDb,
        executionAuthority: f.coordinator,
        backend: {
          async cancel(r, lifecycle) {
            effects++;
            await lifecycle.started(admission);
            await f.append(fact);
            await db
              .updateTable("runs")
              .set({ native_output_drained: true })
              .where("id", "=", request.runId)
              .execute();
            projection = new PostgresDurableCommitProjector(measured).project(fact, {
              topic: `test-${f.worker}`,
              partition: 0,
              offset: 0n,
            });
            void projection.catch((error) => nativeLocked.reject(error));
            await nativeLocked.promise;
            stopped = true;
            return { reason: r.reason, forced: false };
          },
        },
      }).dispatchTargetRun(f.accepted.runId);
      void cancelled.then(
        (result) =>
          nativeLocked.reject(
            new Error(`Cancellation ended before projection gate: ${result.status}`),
          ),
        (error) => nativeLocked.reject(error),
      );
      try {
        await nativeLocked.promise;
        await vi.waitFor(async () => {
          const locks = await sql<{ n: number }>`select count(*)::int n from pg_stat_activity
          where datname=${name} and wait_event_type='Lock'`.execute(db);
          expect(locks.rows[0]!.n).toBeGreaterThan(0);
        });
        releaseNative.resolve();
        await projection;
        expect(await cancelled).toMatchObject({ status: "cancelled" });
        expect(effects).toBe(1);
        expect(settlementAttempts).toBe(injectAbort ? 2 : 1);
        expect(
          (
            await sql<{ count: string }>`select count(*) as count from pi_durable_commits
            where tenant_id=${fact.scope.tenantId}::uuid and session_id=${fact.scope.piSessionId}`.execute(
              db,
            )
          ).rows[0]!,
        ).toEqual({ count: "1" });
        await f.project();
        expect((await f.state()).run.state).toBe("cancelled");
      } finally {
        releaseNative.resolve();
        finish.resolve();
        await Promise.allSettled([executing, cancelled, ...(projection ? [projection] : [])]);
        if (injectAbort)
          await sql`drop trigger abort_first_cancellation on run_transitions;
        drop function abort_first_cancellation(); drop sequence cancellation_abort_once;`.execute(
            db,
          );
      }
    },
  );

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
    expect((await f.state()).worker.state).toBe("ready");
    expect(await f.executor().dispatchRun(f.accepted.runId)).toEqual({ status: "idle" });
    const seal = await db
      .selectFrom("outbox")
      .where("aggregate_type", "=", "session_terminal_event")
      .select("payload")
      .where("tenant_id", "=", f.tenant.tenantId)
      .executeTakeFirstOrThrow();
    expect(seal.payload).toMatchObject({ closesWriter: false }); // known-empty local writer drained
    await f.project();
    const attempt = await db
      .selectFrom("runs")
      .select(["output_first_offset", "output_sealed_at"])
      .where("id", "=", f.accepted.runId)
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
      .updateTable("sessions")
      .set({ pi_session_id: f.session.sessionId, pi_conversation_id: "2" })
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
      expect(s.worker.state).toBe("ready");
      expect(s.leases).toHaveLength(1);
      const attempts = await db
        .selectFrom("runs")
        .select(["lease_id"])
        .where("tenant_id", "=", f.tenant.tenantId)
        .execute();
      expect(new Set(attempts.map((a) => a.lease_id)).size).toBe(1);
    } finally {
      release.resolve();
      await pending;
    }
    expect((await f.state()).leases).toHaveLength(0);
  });
  it("competing claims start the same Run once without a PG slot reservation", async () => {
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
      expect(f.runner).toHaveBeenCalledOnce();
      expect((await f.state()).admittedRuns).toHaveLength(1);
      expect((await f.state()).worker.state).toBe("ready");
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
          .selectFrom("runs")
          .select("output_sealed_at")
          .where("id", "=", f.accepted.runId)
          .executeTakeFirstOrThrow()
      ).output_sealed_at,
    ).not.toBeNull();
  });
  it("owner loss requires ordered closure before the same logical Run is readied", async () => {
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
      .updateTable("runs")
      .set({
        started_at: new Date(Date.now() - 120000),
      })
      .where("id", "=", f.accepted.runId)
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
    expect((await f.state()).run.state).toBe("running");
    expect(await f.executor().dispatchRun(f.accepted.runId)).toEqual({ status: "idle" });
    await f.project();
    const recovered = await db
      .selectFrom("runs")
      .select(["state", "lease_id", "ready_at"])
      .where("id", "=", f.accepted.runId)
      .executeTakeFirstOrThrow();
    expect(recovered).toMatchObject({ state: "queued", lease_id: null });
    expect(recovered.ready_at).not.toBeNull();
  });

  it.each(["before_commit", "after_commit"])(
    "co-commits the first native floor and replays after %s failure",
    async (phase) => {
      const f = await fixture();
      expect(await f.executor().dispatchRun(f.accepted.runId)).toMatchObject({
        status: "completed",
      });
      const fact: Extract<AcceptedFact, { kind: "durable_commit" }> = {
        kind: "durable_commit",
        factId: randomUUID(),
        scope: f.facts[0]!.scope,
        commit: { seq: 1, nextId: 2, writes: [{ type: "conversation", value: { id: 1 } }] },
        origins: [],
        tools: [],
        cancellations: [],
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
        .selectFrom("runs")
        .select("output_first_offset")
        .where("id", "=", fact.scope.runId)
        .executeTakeFirstOrThrow();
      expect(floor.output_first_offset).toBe(phase === "before_commit" ? null : "10");
      await projector.project(record);
      expect(
        (
          await sql<{
            seq: string;
          }>`select seq from pi_durable_commits where tenant_id=${fact.scope.tenantId}::uuid and session_id=${fact.scope.piSessionId} and seq=${fact.commit.seq}`.execute(
            db,
          )
        ).rows,
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
