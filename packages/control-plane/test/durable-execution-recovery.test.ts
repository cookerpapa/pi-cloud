import { beforeAll, afterAll, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { createDatabase, runMigrations, type Database } from "@pi-cloud/database";
import { ControlPlaneStore, createPrivateTenant } from "../src/index.ts";
import { createTestWorker } from "./admit-test-execution.ts";
import { TurnExecutionBackendError } from "../../runtime-core/src/run-executor.ts";
import {
  ExecutionStreamProjector,
  ExecutionStreamBoundary,
} from "../../runtime-core/src/execution-stream-projection.ts";
import { parseKafkaAcceptedFact } from "../../runtime-core/src/kafka-accepted-fact.ts";
import type {
  AcceptedDurableCommitFact,
  AcceptedExecutionSealFact,
} from "../../runtime-core/src/accepted-fact.ts";
import { PostgresDurableCommitProjector } from "../../runtime-core/src/postgres-durable-commit-projector.ts";
import { confirmAgentExit } from "../../runtime-core/src/quarantined-session-recovery.ts";

let db: Kysely<Database>, store: ControlPlaneStore, tenantId: string;
beforeAll(async () => {
  db = createDatabase({
    connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL!,
    maxConnections: 3,
  });
  await runMigrations(db, "up");
  const tenant = await createPrivateTenant(db, {
    slug: `durable-${crypto.randomUUID()}`,
    ownerDisplayName: "Durable test",
  });
  tenantId = tenant.tenantId;
  store = new ControlPlaneStore({
    database: db,
    tenantId,
    defaultModelProfileId: tenant.defaultModelProfileId,
  });
}, 60000);
afterAll(async () => {
  await db?.destroy();
});

it.each(["none", "before_seal", "after_seal"] as const)(
  "re-admits the same Run after closure and preserves Stop (%s)",
  async (stop) => {
    const project = await store.createProject({
      name: `Recovery-${stop}`,
      source: { kind: "empty" },
    });
    await db
      .updateTable("environment_versions")
      .set({ state: "validated", validated_at: new Date() })
      .where("id", "=", project.environment.environmentVersionId)
      .execute();
    const session = await store.createSession(
      project.projectId,
      project.workspaceId,
      "Recovery",
      "elastic",
    );
    const turn = await store.acceptTurn(session.sessionId, "recover-once", {
      prompt: "preserve this logical input",
    });
    const old = await createTestWorker(db),
      replacement = await createTestWorker(db);
    const first = old.executor({
      execute: async () => {
        throw new TurnExecutionBackendError("worker_shutdown", "owner stopped", true);
      },
    });
    expect((await first.dispatchRun(turn.runId)).status).toBe("recovering");
    const outbox = await db
      .selectFrom("outbox")
      .select("payload")
      .where(
        sql<boolean>`payload->>'kind'='execution_seal' and payload#>>'{scope,runId}'=${turn.runId}`,
      )
      .executeTakeFirstOrThrow();
    const seal = parseKafkaAcceptedFact(
      JSON.stringify(outbox.payload),
    ) as AcceptedExecutionSealFact;
    expect(seal.recover).toBe(true);
    expect(seal.terminal).toBeUndefined();
    const requestStop = () =>
      store.acceptTurnCancellation(session.sessionId, turn.turnId, "stop-recovery", {
        gracePeriodMs: 1000,
      });
    if (stop === "before_seal") await requestStop();
    const started = Promise.withResolvers<void>(),
      finish = Promise.withResolvers<void>();
    const next = replacement.executor({
      execute: async (request) => {
        expect(request.runId).toBe(turn.runId);
        expect(request.turnId).toBe(turn.turnId);
        expect(request.stopOnResume).toBe(stop === "none" ? undefined : true);
        started.resolve();
        await finish.promise;
        if (stop !== "none")
          throw new TurnExecutionBackendError("worker_shutdown", "second owner stopped", true);
        return { stopReason: "stop", lastEventSeq: Number(request.nextEventSeq) - 1 };
      },
    });
    expect(await next.dispatchRun(turn.runId)).toEqual({ status: "idle" });
    const native: AcceptedDurableCommitFact = {
      kind: "durable_commit",
      factId: crypto.randomUUID(),
      scope: seal.scope,
      occurredAt: seal.occurredAt,
      commit: { seq: 1, nextId: 2, writes: [{ type: "conversation", value: { id: 1 } }] },
      origins: [],
      tools: [],
      cancellations: [],
      display: [],
    };
    const prefix = { fact: native, topic: "recovery-test", partition: 0, offset: 0n };
    const displaced = new ExecutionStreamProjector(db);
    await displaced.project(prefix);
    const projector = new ExecutionStreamProjector(db);
    await projector.project(prefix);
    const record = { fact: seal, topic: "recovery-test", partition: 0, offset: 2n };
    await projector.project(record);
    const queued = await db
      .selectFrom("runs")
      .selectAll()
      .where("id", "=", turn.runId)
      .executeTakeFirstOrThrow();
    expect(queued.state).toBe("queued");
    expect(queued.lease_id).toBeNull();
    expect(queued.ready_at).not.toBeNull();
    expect(
      (
        await db
          .selectFrom("pi_sessions")
          .select("unsealed_runs")
          .where("id", "=", seal.scope.piSessionId)
          .executeTakeFirstOrThrow()
      ).unsealed_runs,
    ).toBe("0");
    if (stop === "after_seal") await requestStop();
    if (stop !== "none") {
      const control = await db
        .selectFrom("turn_control_requests")
        .select("payload")
        .where("target_run_id", "=", turn.runId)
        .where("kind", "=", "cancel")
        .executeTakeFirstOrThrow();
      expect(control.payload).toMatchObject({ inputReturnPending: true });
    }
    const running = next.dispatchRun(turn.runId);
    try {
      await started.promise;
      const current = await db
        .selectFrom("runs")
        .select(["lease_id", "agent_exited_at"])
        .where("id", "=", turn.runId)
        .executeTakeFirstOrThrow();
      expect(current.lease_id).not.toBe(seal.scope.writerId);
      // This handler cached OPEN before replacement and resumes after the new
      // grant. Both native and already-covered display writes must recheck PG.
      const late = { ...native, commit: { seq: 2, nextId: 2, writes: [] } };
      await new PostgresDurableCommitProjector(db).project(late, { ...prefix, offset: 1n });
      expect(
        (
          await sql`select seq from pi_durable_commits where tenant_id=${tenantId}::uuid
        and session_id=${seal.scope.piSessionId} order by seq`.execute(db)
        ).rows,
      ).toEqual([{ seq: "1" }]);
      await db
        .updateTable("runs")
        .set({ output_display_seq: "100", output_display_native_seq: "1" })
        .where("id", "=", turn.runId)
        .execute();
      await expect(
        displaced.project({
          ...prefix,
          offset: 1n,
          fact: {
            kind: "agent_event",
            factId: crypto.randomUUID(),
            scope: seal.scope,
            occurredAt: seal.occurredAt,
            nativeSequence: 1,
            event: {
              schemaVersion: 1,
              eventId: crypto.randomUUID(),
              sessionId: session.sessionId,
              turnId: turn.turnId,
              agentId: "root",
              seq: 1,
              occurredAt: seal.occurredAt,
              type: "assistant.text.delta",
              payload: { text: "stale coverage" },
            },
          },
        }),
      ).rejects.toThrow("Display checkpoint preceded its native commit");
      await projector.project(record);
      await confirmAgentExit(db, {
        tenantId,
        sessionId: session.sessionId,
        runId: turn.runId,
        leaseId: seal.scope.writerId,
      });
      const unchanged = await db
        .selectFrom("runs")
        .select(["lease_id", "agent_exited_at", "state"])
        .where("id", "=", turn.runId)
        .executeTakeFirstOrThrow();
      expect(unchanged).toEqual({ ...current, state: "running" });
      const boundary = new ExecutionStreamBoundary(db);
      expect(await boundary.isOpen(record, true)).toBe(false);
      const count = await db
        .selectFrom("runs")
        .select(({ fn }) => fn.countAll<string>().as("count"))
        .where("session_id", "=", session.sessionId)
        .executeTakeFirstOrThrow();
      expect(count.count).toBe("1");
    } finally {
      finish.resolve();
      await running;
    }
  },
  30000,
);
