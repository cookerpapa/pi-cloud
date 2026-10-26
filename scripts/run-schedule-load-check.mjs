import "reflect-metadata";
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { sql } from "kysely";
import { createDatabase, runMigrations } from "../packages/database/src/index.ts";
import { ControlPlaneStore } from "../packages/control-plane/src/control-plane-store.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { SessionScheduleService } from "../packages/control-plane/src/session-schedule-service.ts";
import { SessionScheduleController } from "../packages/control-plane/src/session-schedule-controller.ts";
import { createControlPlaneApplication } from "../packages/control-plane/src/application.ts";
import { emptyEventRuntime } from "../packages/control-plane/test/fixtures/event-runtime.ts";

if (
  process.env.PI_CLOUD_SCHEDULE_LOAD_CHECK !== "1" ||
  !process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL
)
  throw Error("Use the isolated PG runner and PI_CLOUD_SCHEDULE_LOAD_CHECK=1");
const count = Number(process.env.PI_CLOUD_SCHEDULE_LOAD_COUNT ?? 10000);
assert(Number.isSafeInteger(count) && count >= 10000, "Acceptance requires at least 10,000 plans");
const reportPath = resolve(
  process.argv[2] ?? "deploy/production/runtime/release-evidence/schedules-20261026/load.json",
);
await mkdir(dirname(reportPath), { recursive: true, mode: 0o700 });
const admin = new Pool({ connectionString: process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL, max: 1 });
const name = "schedule_load_" + randomUUID().replaceAll("-", "");
let primary, admission, controller, app;
const report = {
  at: new Date().toISOString(),
  sourceRevision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  inputSha256: Object.fromEntries(
    await Promise.all(
      [
        "scripts/run-schedule-load-check.mjs",
        "packages/control-plane/src/session-schedule-service.ts",
        "packages/control-plane/src/session-schedule-controller.ts",
        "packages/control-plane/src/control-plane-store.ts",
        "packages/database/src/migrations/202_session_schedules.ts",
      ].map(async (path) => [
        path,
        createHash("sha256")
          .update(await readFile(path))
          .digest("hex"),
      ]),
    ),
  ),
  accepted: false,
  isolated: true,
  plansPerScenario: count,
  agentExecutions: 0,
  projectorTrafficMeasured: false,
  scenarios: [],
};
const quantiles = (values) => {
  const a = [...values].sort((a, b) => a - b);
  return {
    samples: a.length,
    p50: a[Math.floor(a.length * 0.5)] ?? 0,
    p95: a[Math.floor(a.length * 0.95)] ?? 0,
    p99: a[Math.floor(a.length * 0.99)] ?? 0,
    max: a.at(-1) ?? 0,
  };
};
try {
  await admin.query(`create database "${name}"`);
  const url = new URL(process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL);
  url.pathname = "/" + name;
  primary = createDatabase({ connectionString: url.toString(), maxConnections: 4 });
  let queries = 0;
  admission = createDatabase({ connectionString: url.toString(), maxConnections: 3 }).withPlugin({
    transformQuery: ({ node }) => {
      queries++;
      return node;
    },
    transformResult: async ({ result }) => result,
  });
  await runMigrations(primary, "up");
  const tenant = await createPrivateTenant(primary, {
    slug: "schedule-load-" + randomUUID(),
    ownerDisplayName: "Owned schedule load",
  });
  const store = new ControlPlaneStore({ database: primary, ...tenant });
  const project = await store.createProject({ name: "Load fixture", source: { kind: "empty" } });
  const sessions = [];
  for (let i = 0; i < 100; i++)
    sessions.push(
      (await store.createSession(project.projectId, project.workspaceId, "Load " + i, "elastic"))
        .sessionId,
    );
  const service = new SessionScheduleService({ database: primary, admissionDatabase: admission });
  app = await createControlPlaneApplication({
    database: primary,
    tenantId: tenant.tenantId,
    defaultModelProfileId: tenant.defaultModelProfileId,
    eventRuntime: emptyEventRuntime(),
    schedules: service,
  });
  const http = app.getHttpAdapter().getInstance();
  await http.ready();
  for (const scenario of ["sparse", "burst_distributed", "burst_one_session"]) {
    const ids = [];
    const base = new Date(
      (await sql`select clock_timestamp() as now`.execute(primary)).rows[0].now,
    );
    for (let offset = 0; offset < count; offset += 200) {
      const values = [];
      for (let i = offset; i < Math.min(count, offset + 200); i++) {
        const id = randomUUID();
        ids.push(id);
        const at = new Date(
          base.valueOf() + 3600000 + (scenario === "sparse" ? (i * 86400000) / count : 0),
        );
        values.push({
          id,
          tenant_id: tenant.tenantId,
          session_id: sessions[scenario === "burst_one_session" ? 0 : i % sessions.length],
          name: `${scenario}-${i}`,
          prompt: "Return SCHEDULE_LOAD_OK without tools.",
          timing: JSON.stringify({ kind: "once", at: at.toISOString() }),
          missed: "latest",
          next_fire_at: at,
          available_at: at,
          create_request_sha256: "a".repeat(64),
        });
      }
      await primary.insertInto("session_schedules").values(values).execute();
    }
    await sql`analyze session_schedules; analyze runs; analyze sessions`.execute(primary);
    const nearest = (
      await sql`explain (analyze,buffers,format json) select available_at from session_schedules where enabled order by available_at,id limit 1`.execute(
        primary,
      )
    ).rows;
    const row = { scenario, count, queryPlan: nearest };
    report.scenarios.push(row);
    assert(
      JSON.stringify(nearest).includes("session_schedules_due"),
      "Nearest-time lookup must use the due index",
    );
    let controllerErrors = 0,
      admitted = 0;
    const beforeQueries = queries,
      beforeHeap = process.memoryUsage().heapUsed;
    controller = new SessionScheduleController({
      service,
      notificationConnectionString: url.toString(),
      onError: () => controllerErrors++,
      onBatch: (r) => {
        admitted += r.admitted;
      },
    });
    controller.start();
    if (scenario === "sparse") {
      await delay(2200);
      row.idleQueries = queries - beforeQueries;
      assert(row.idleQueries <= 3, "Idle scheduler is polling rather than waiting");
      // Updating only names must not wake the deadline controller.
      const prior = queries;
      for (let i = 0; i < 100; i++)
        await primary
          .updateTable("session_schedules")
          .set({ name: "Edited name", revision: sql`revision+1` })
          .where("id", "=", ids[i])
          .execute();
      await delay(100);
      row.nameEditWakeQueries = queries - prior;
      assert.equal(row.nameEditWakeQueries, 0);
      // An earlier relative deadline interrupts the previous one-hour wait.
      const scope = { tenantId: tenant.tenantId, sessionId: sessions[0] };
      const p = await service.get(scope, ids[0]);
      const moved = await service.change(scope, p.id, {
        action: "update",
        revision: p.revision,
        patch: { timing: { kind: "after", seconds: 1 } },
      });
      const end = Date.now() + 10000;
      while (Date.now() < end && !admitted) await delay(50);
      assert.equal(admitted, 1, "Earlier edited deadline was not delivered");
      row.earlierEditDelivered = true;
      row.plannedAt = moved.nextFireAt;
    } else {
      const planned = new Date(Date.now() + 1000);
      await primary
        .updateTable("session_schedules")
        .set({
          next_fire_at: planned,
          available_at: planned,
          timing: JSON.stringify({ kind: "once", at: planned.toISOString() }),
        })
        .where("name", "like", scenario + "-%")
        .execute();
      const loop = monitorEventLoopDelay({ resolution: 10 });
      loop.enable();
      const latency = [];
      let probing = false;
      const probe = setInterval(() => {
        if (probing) return;
        probing = true;
        const start = performance.now();
        void http
          .inject({ method: "GET", url: `/v1/conversations/${sessions[0]}/schedules` })
          .then((r) => {
            assert.equal(r.statusCode, 200);
            latency.push(performance.now() - start);
          })
          .finally(() => {
            probing = false;
          });
      }, 250);
      const start = performance.now(),
        deadline = Date.now() + 600000;
      try {
        while (admitted < count && Date.now() < deadline) await delay(100);
        assert.equal(admitted, count, "Not every occurrence was admitted");
      } finally {
        clearInterval(probe);
        while (probing) await delay(10);
        loop.disable();
      }
      const duration = performance.now() - start;
      row.durationMs = duration;
      row.admissionsPerSecond = count / (duration / 1000);
      row.apiLatencyMs = quantiles(latency);
      row.eventLoopP99Ms = loop.percentile(99) / 1e6;
      const { rows } =
        await sql`select extract(epoch from (r.created_at-(r.scheduled_origin->>'scheduledAt')::timestamptz))*1000 as delay_ms
     from runs r where r.tenant_id=${tenant.tenantId}::uuid and r.scheduled_origin->>'name' like ${scenario + "-%"}`.execute(
          primary,
        );
      assert.equal(rows.length, count);
      row.admissionLatencyMs = quantiles(rows.map((r) => Number(r.delay_ms)));
      const duplicate = (
        await sql`select 1 from runs where tenant_id=${tenant.tenantId}::uuid and scheduled_origin->>'name' like ${scenario + "-%"} group by idempotency_key having count(*)>1`.execute(
          primary,
        )
      ).rows;
      assert.equal(duplicate.length, 0);
      row.duplicateAdmissions = 0;
      // No Worker is connected to this isolated database. This is admission throughput.
      const ready = await primary
        .selectFrom("runs")
        .select(({ fn }) => fn.countAll().as("count"))
        .where("tenant_id", "=", tenant.tenantId)
        .where("ready_at", "is not", null)
        .executeTakeFirst();
      row.readyRuns = Number(ready.count);
    }
    await controller.close();
    controller = undefined;
    assert.equal(controllerErrors, 0);
    row.controllerErrors = controllerErrors;
    row.sqlStatements = queries - beforeQueries;
    row.heapDeltaBytes = process.memoryUsage().heapUsed - beforeHeap;
    await primary
      .deleteFrom("session_schedules")
      .where("tenant_id", "=", tenant.tenantId)
      .execute();
    // End only these synthetic, unclaimed Runs so the next scenario tests its own queue heads.
    await primary
      .updateTable("runs")
      .set({ state: "cancelled", ready_at: null, settled_at: new Date() })
      .where("tenant_id", "=", tenant.tenantId)
      .where("state", "=", "queued")
      .execute();
    console.log(
      JSON.stringify({
        scenario,
        count,
        sqlStatements: row.sqlStatements,
        durationMs: row.durationMs,
        admissionsPerSecond: row.admissionsPerSecond,
      }),
    );
  }
  report.accepted = true;
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  await controller?.close();
  await app?.close();
  await admission?.destroy();
  await primary?.destroy();
  try {
    await admin.query(`drop database if exists "${name}"`);
    report.cleanupConfirmed = true;
  } finally {
    await admin.end();
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
}
