// Review reproducer for baseline 4294c759. No production resources are touched.
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { sql } from "kysely";
import { createDatabase, runMigrations } from "../../../packages/database/src/index.ts";
import { createPrivateTenant } from "../../../packages/control-plane/src/tenant-administration.ts";
import { ControlPlaneStore } from "../../../packages/control-plane/src/control-plane-store.ts";
import { createTestWorker } from "../../../packages/control-plane/test/admit-test-execution.ts";
import { RunCancellationExecutor } from "../../../packages/runtime-core/src/run-cancellation-executor.ts";
import { TurnExecutionCancelledError } from "../../../packages/runtime-core/src/run-executor.ts";
const endpoint = process.env.PI_CLOUD_REVIEW_DATABASE_URL;
if (!endpoint || !["127.0.0.1", "localhost"].includes(new URL(endpoint).hostname))
  throw new Error("Provide an isolated loopback PostgreSQL URL via PI_CLOUD_REVIEW_DATABASE_URL");
const name = "review_clock_" + randomUUID().replaceAll("-", "");
const admin = createDatabase({ connectionString: endpoint, maxConnections: 1 });
await sql`create database ${sql.id(name)}`.execute(admin);
const url = new URL(endpoint);
url.pathname = "/" + name;
const db = createDatabase({ connectionString: url.toString(), maxConnections: 4 });
const ready = Promise.withResolvers(),
  interrupt = Promise.withResolvers(),
  exited = Promise.withResolvers();
let execution, reference;
let calls = 0;
try {
  await runMigrations(db, "up");
  const tenant = await createPrivateTenant(db, {
    slug: name.replaceAll("_", "-"),
    ownerDisplayName: "Review",
  });
  const store = new ControlPlaneStore({ database: db, ...tenant });
  const p = await store.createProject({ name: "Review", source: { kind: "empty" } });
  const s = await store.createSession(p.projectId, p.workspaceId, "Review", "elastic");
  const run = await store.acceptTurn(s.sessionId, randomUUID(), {
    prompt: "Synthetic cancellation test",
  });
  const w = await createTestWorker(db);
  execution = w
    .executor({
      async execute(r, l, a) {
        reference = a.executionReference;
        ready.resolve();
        await interrupt.promise;
        l.executionExited();
        exited.resolve();
        throw new TurnExecutionCancelledError("user_request", false);
      },
    })
    .dispatchRun(run.runId);
  void execution.catch(ready.reject);
  await ready.promise;
  await store.acceptTurnCancellation(s.sessionId, run.turnId, randomUUID(), {});
  const pending =
    await sql`select count(*)::int n from turn_control_requests where target_run_id=${run.runId}::uuid and available_at<=clock_timestamp() and state='pending'`.execute(
      db,
    );
  const backend = {
    async cancel(req, l) {
      calls++;
      await l.started({ executionReference: reference });
      interrupt.resolve();
      await exited.promise;
      return { reason: req.reason, forced: false };
    },
  };
  const slow = new RunCancellationExecutor({
    database: db,
    executionAuthority: w.coordinator,
    backend,
    clock: () => new Date(Date.now() - 60000),
  });
  const result = await slow.dispatchTargetRun(run.runId);
  const slowCalls = calls;
  const aligned = new RunCancellationExecutor({
    database: db,
    executionAuthority: w.coordinator,
    backend,
  });
  const next = await aligned.dispatchTargetRun(run.runId);
  await execution;
  const report = {
    baseline: "4294c759",
    clockSkewMs: -60000,
    pgDueRequests: pending.rows[0].n,
    skewedClockResult: result,
    skewedClockBackendCalls: slowCalls,
    alignedClockStatus: next.status,
    alignedClockBackendCalls: calls,
  };
  await writeFile(
    "/tmp/pi-cloud-review-cancel-clock-result.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  interrupt.resolve();
  await execution?.catch(() => {});
  await db.destroy();
  await sql`drop database ${sql.id(name)}`.execute(admin);
  await admin.destroy();
}
