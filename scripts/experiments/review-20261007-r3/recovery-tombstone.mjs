import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { sql } from "kysely";
import { testPostgres } from "../../lib/test-postgres.mjs";
import { createDatabase, runMigrations } from "../../../packages/database/src/index.ts";
import { ControlPlaneStore } from "../../../packages/control-plane/src/control-plane-store.ts";
import { createPrivateTenant } from "../../../packages/control-plane/src/tenant-administration.ts";
import { createTestWorker } from "../../../packages/control-plane/test/admit-test-execution.ts";
import { TurnExecutionCancelledError } from "../../../packages/runtime-core/src/run-executor.ts";
import {
  RunCancellationExecutor,
  TurnCancellationBackendError,
} from "../../../packages/runtime-core/src/run-cancellation-executor.ts";
import { ExecutionStreamProjector } from "../../../packages/runtime-core/src/execution-stream-projection.ts";
import { parseKafkaAcceptedFact } from "../../../packages/runtime-core/src/kafka-accepted-fact.ts";

const pg = await testPostgres({});
const db = createDatabase({ connectionString: pg.url, maxConnections: 8 });
const cases = [];
try {
  await runMigrations(db, "up");
  let offset = 0n;
  for (const order of ["exit-first", "seal-first"])
    for (const queued of [false, true]) {
      const tenant = await createPrivateTenant(db, {
        slug: "review-" + randomUUID(),
        ownerDisplayName: "Owned recovery review",
      });
      const store = new ControlPlaneStore({ database: db, ...tenant });
      const p = await store.createProject({ name: "owned", source: { kind: "empty" } });
      const s = await store.createSession(p.projectId, p.workspaceId, "owned", "elastic");
      const first = await store.acceptTurn(s.sessionId, randomUUID(), { prompt: "active" });
      const worker = await createTestWorker(db),
        entered = Promise.withResolvers(),
        finish = Promise.withResolvers();
      let reference;
      const executing = worker
        .executor({
          async execute(_request, lifecycle, admission) {
            reference = admission.executionReference;
            entered.resolve();
            await finish.promise;
            lifecycle.executionExited();
            throw new TurnExecutionCancelledError("user_request", false);
          },
        })
        .dispatchRun(first.runId);
      void executing.catch(entered.reject);
      await entered.promise;
      try {
        const later = queued
          ? await store.acceptTurn(s.sessionId, randomUUID(), { prompt: "not executed" })
          : undefined;
        await store.acceptTurnCancellation(s.sessionId, first.turnId, randomUUID(), {});
        const cancellation = new RunCancellationExecutor({
          database: db,
          executionAuthority: worker.coordinator,
          backend: {
            async cancel(_request, lifecycle) {
              await lifecycle.started({ executionReference: reference });
              throw new TurnCancellationBackendError(
                "cleanup_failed",
                "Owned failure: no initial exit confirmation",
                false,
              );
            },
          },
        });
        const failed = await cancellation.dispatchTargetRun(first.runId);
        assert.equal(failed.status, "failed");
        if (order === "exit-first") {
          finish.resolve();
          await executing;
        }
        const seal = await db
          .selectFrom("outbox")
          .select("payload")
          .where(sql`payload->>'kind'='execution_seal'`)
          .where(sql`payload#>>'{scope,runId}'=${first.runId}`)
          .executeTakeFirstOrThrow();
        await new ExecutionStreamProjector(db).project({
          fact: parseKafkaAcceptedFact(JSON.stringify(seal.payload)),
          topic: "owned-recovery-review",
          partition: 0,
          offset: offset++,
        });
        if (order === "seal-first") {
          finish.resolve();
          await executing;
        }
        const session = await db
          .selectFrom("sessions")
          .select("state")
          .where("id", "=", s.sessionId)
          .executeTakeFirstOrThrow();
        const row = await db
          .selectFrom("runs")
          .select(["state", "agent_exited_at", "output_sealed_at"])
          .where("id", "=", first.runId)
          .executeTakeFirstOrThrow();
        const queuedRow = later
          ? await db
              .selectFrom("runs")
              .select(["state", "lease_id", "started_at", "stop_reason"])
              .where("id", "=", later.runId)
              .executeTakeFirstOrThrow()
          : undefined;
        let accepted = false,
          code;
        try {
          await store.acceptTurn(s.sessionId, randomUUID(), {
            prompt: "continue after confirmed exit and seal",
          });
          accepted = true;
        } catch (error) {
          code = error.code;
        }
        cases.push({
          order,
          queuedInputWithdrawn: queued,
          sessionState: session.state,
          failedRunState: row.state,
          agentExitConfirmed: !!row.agent_exited_at,
          sealConfirmed: !!row.output_sealed_at,
          queuedRow,
          nextInputAccepted: accepted,
          rejection: code,
        });
      } finally {
        finish.resolve();
        await executing;
      }
    }
} finally {
  await db.destroy();
  await pg.close();
}
const result = {
  scope:
    "isolated real PostgreSQL; actual admission/cancellation/closure code; controlled Worker exit",
  cases,
};
await writeFile(
  process.argv[2] ?? "/tmp/pi-cloud-recovery-tombstone.json",
  JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result));
