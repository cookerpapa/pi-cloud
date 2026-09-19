import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { ControlPlaneStore } from "../src/control-plane-store.ts";
import { createPrivateTenant } from "../src/tenant-administration.ts";
import { AgentRunSupervisor } from "@pi-cloud/sandbox-supervisor";
import { AgentRunExecutionBackend } from "../../runtime-core/src/agent-run-execution-backend.ts";
import { SessionLeaseCoordinator } from "../../runtime-core/src/session-lease-coordinator.ts";
import { RunExecutor } from "@pi-cloud/runtime-core/run-executor";
import type { RunCancellationExecutor } from "@pi-cloud/runtime-core/run-cancellation-executor";
import { DirectExecutionLog } from "../../runtime-core/src/direct-execution-log.ts";
import { ExecutionPublicationBoundary } from "../../runtime-core/src/execution-publication.ts";
import { ExecutionStreamProjector } from "../../runtime-core/src/execution-stream-projection.ts";
import type { AcceptedFact } from "../../runtime-core/src/accepted-fact.ts";
import { PostgresPiWorker } from "../../supervisor-host/src/postgres-pi-worker.ts";

const endpoint =
  process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL ??
  process.env.PI_CLOUD_PI_SESSION_CONFORMANCE_DATABASE_URL;
describe.skipIf(!endpoint)("two-way Worker / PostgreSQL admission", () => {
  const name = `pi_parallel_claim_${randomUUID().replaceAll("-", "")}`;
  let admin: Kysely<Database>, db: Kysely<Database>, url: URL;
  beforeAll(async () => {
    admin = createDatabase({ connectionString: endpoint!, maxConnections: 1 });
    await sql`create database ${sql.id(name)}`.execute(admin);
    url = new URL(endpoint!);
    url.pathname = `/${name}`;
    db = createDatabase({ connectionString: url.toString(), maxConnections: 8 });
    await runMigrations(db, "up");
  }, 60000);
  afterAll(async () => {
    await db?.destroy();
    if (admin) {
      await vi.waitFor(async () =>
        expect(
          (
            await sql<{
              n: number;
            }>`select count(*)::int n from pg_stat_activity where datname=${name}`.execute(admin)
          ).rows[0]!.n,
        ).toBe(0),
      );
      await sql`drop database ${sql.id(name)}`.execute(admin);
      await admin.destroy();
    }
  });

  it("overlaps distinct claims but preserves capacity, same-Session order and the seal barrier", async () => {
    const tenant = await createPrivateTenant(db, {
        slug: `parallel-${randomUUID()}`,
        ownerDisplayName: "Parallel test",
      }),
      store = new ControlPlaneStore({ database: db, ...tenant });
    const resource = await store.createProject({ name: "shared files", source: { kind: "empty" } });
    const sessions = await Promise.all(
      ["a", "b", "c"].map((title) =>
        store.createSession(resource.projectId, resource.workspaceId, title, "elastic"),
      ),
    );
    const first = await store.acceptTurn(sessions[0]!.sessionId, randomUUID(), { prompt: "first" });
    const second = await store.acceptTurn(sessions[1]!.sessionId, randomUUID(), {
      prompt: "second",
    });
    const third = await store.acceptTurn(sessions[2]!.sessionId, randomUUID(), { prompt: "third" });
    const follow = await store.acceptTurn(sessions[0]!.sessionId, randomUUID(), {
      prompt: "follow-up",
    });
    const workerId = randomUUID();
    await db
      .insertInto("sandboxes")
      .values({
        id: workerId,
        supervisor_id: workerId,
        boot_id: randomUUID(),
        state: "ready",
        max_concurrent_sessions: 2,
      })
      .execute();
    const coordinator = new SessionLeaseCoordinator({ database: db, sandboxId: workerId });
    const facts: AcceptedFact[] = [],
      started: string[] = [],
      entered = new Set<string>(),
      pids = new Set<number>();
    const releaseAdmission = Promise.withResolvers<void>();
    const gates = new Map(
      [first, second, third, follow].map((r) => [r.runId, Promise.withResolvers<void>()]),
    );
    const supervisor = new AgentRunSupervisor({
      maxConcurrentSessions: 2,
      runner: {
        run: async (command) => {
          started.push(command.payload.runId);
          await gates.get(command.payload.runId)!.promise;
          return { stopReason: "stop" };
        },
      },
    });
    const backend = new AgentRunExecutionBackend({
      supervisor,
      leaseCoordinator: coordinator,
      executionLogs: new DirectExecutionLog(db, {
        checkHealth: async () => {},
        append: async (fact) => {
          facts.push(fact);
          return { factId: fact.factId, durable: true };
        },
      }),
    });
    const executor = new RunExecutor({
      database: db,
      workerId: workerId,
      executionAuthority: coordinator,
      backend: {
        admit: async (tx, r, mark, facts) => {
          if (r.runId === first.runId || r.runId === second.runId) {
            entered.add(r.runId);
            pids.add(
              (await sql<{ pid: number }>`select pg_backend_pid() pid`.execute(tx)).rows[0]!.pid,
            );
            await releaseAdmission.promise;
          }
          return backend.admit(tx, r, mark, facts);
        },
        execute: backend.execute.bind(backend),
      },
    });
    const failures: unknown[] = [];
    let localFamilies = 0;
    const worker = new PostgresPiWorker({
      database: db,
      notificationConnectionString: url.toString(),
      identity: workerId,
      maximumActiveFamilies: 2,
      maximumLanesPerFamily: 4,
      memoryHeadroom: () => true,
      onCapacity: (sample) => {
        localFamilies = sample.families;
      },
      pollIntervalMs: 25,
      runExecutor: executor,
      cancellationExecutor: {} as RunCancellationExecutor,
      onFailure: (_op, error) => failures.push(error),
    });
    const capacity = () => localFamilies;
    let offset = 0n;
    const projected = new Set<string>(),
      boundary = new ExecutionPublicationBoundary(db),
      projector = new ExecutionStreamProjector(db);
    async function project() {
      const outbox = await db
        .selectFrom("outbox")
        .select("payload")
        .where("tenant_id", "=", tenant.tenantId)
        .execute();
      for (const fact of [...facts, ...outbox.map((r) => r.payload as unknown as AcceptedFact)]) {
        if (projected.has(fact.factId)) continue;
        const record = { fact, topic: `parallel-${workerId}`, partition: 0, offset: offset++ };
        if (await boundary.accept(record)) await projector.project(record);
        projected.add(fact.factId);
      }
    }
    await worker.start();
    try {
      await vi.waitFor(() => expect(pids.size).toBe(2), { timeout: 3000 });
      expect(pids.size).toBe(2);
      expect(await capacity()).toBe(0);
      expect(started).toEqual([]);
      releaseAdmission.resolve();
      await vi.waitFor(() => expect(started).toHaveLength(2));
      expect(new Set(started)).toEqual(new Set([first.runId, second.runId]));
      expect(await capacity()).toBe(2);
      expect(
        await db
          .selectFrom("runs")
          .select(["state", "lease_id"])
          .where("id", "=", third.runId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: "queued", lease_id: null });
      gates.get(first.runId)!.resolve();
      await vi.waitFor(() => expect(started).toContain(third.runId));
      expect(await capacity()).toBe(2);
      expect(started).not.toContain(follow.runId);
      gates.get(third.runId)!.resolve();
      await vi.waitFor(async () => expect(await capacity()).toBe(1));
      // A free family slot alone cannot authorize a successor before closure.
      expect(started).not.toContain(follow.runId);
      expect(
        await db
          .selectFrom("runs")
          .select(["state", "lease_id"])
          .where("id", "=", follow.runId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ state: "queued", lease_id: null });
      await project();
      await vi.waitFor(() => expect(started).toContain(follow.runId));
      expect(await capacity()).toBe(2);
      expect(failures).toEqual([]);
    } finally {
      releaseAdmission.resolve();
      const stopping = worker.stop();
      for (const g of gates.values()) g.resolve();
      await stopping;
      await project();
    }
    expect(await capacity()).toBe(0);
    expect(failures).toEqual([]);
  }, 20000);
});
