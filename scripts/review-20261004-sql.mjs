// Client-side SQL round trips in isolated PG. Fake execution; no model/Kafka/VM latency claim.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { Client } from "pg";
import { sql } from "kysely";
import { createDatabase, runMigrations } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { ControlPlaneStore } from "../packages/control-plane/src/control-plane-store.ts";
import { createTestWorker } from "../packages/control-plane/test/admit-test-execution.ts";
import { readInputQueue } from "../packages/control-plane/src/input-queue-snapshot.ts";
import { InputQueueView } from "../packages/control-plane/src/input-queue-view.ts";
import { SandboxBindingView } from "../packages/sandbox-control/src/sandbox-binding-view.ts";

const endpoint = process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL;
if (!endpoint) throw Error("Run with run-with-test-postgres.mjs and a disposable database");
const name = "review_sql_" + randomUUID().replaceAll("-", "");
const admin = createDatabase({ connectionString: endpoint, maxConnections: 1 });
await sql`create database ${sql.id(name)}`.execute(admin);
const url = new URL(endpoint);
url.pathname = "/" + name;
const db = createDatabase({ connectionString: url.toString(), maxConnections: 8 });
const labels = new AsyncLocalStorage(),
  samples = {};
const original = Client.prototype.query;
Client.prototype.query = function (...args) {
  const label = labels.getStore()?.phase;
  if (label) {
    const value = typeof args[0] === "string" ? args[0] : args[0]?.text;
    if (value) {
      const normalized = value.replace(/\s+/g, " ").trim();
      const item = (samples[label] ??= { roundTrips: 0, statements: {} });
      item.roundTrips++;
      item.statements[normalized] = (item.statements[normalized] ?? 0) + 1;
    }
  }
  return original.apply(this, args);
};
const measure = (phase, run) => {
  samples[phase] ??= { roundTrips: 0, statements: {} };
  return labels.run({ phase }, run);
};
let view, running;
const entered = Promise.withResolvers(),
  finish = Promise.withResolvers();
try {
  await runMigrations(db, "up");
  const tenant = await createPrivateTenant(db, {
    slug: name.replaceAll("_", "-"),
    ownerDisplayName: "SQL review",
  });
  const store = new ControlPlaneStore({ database: db, ...tenant });
  const project = await store.createProject({ name: "Review", source: { kind: "empty" } }),
    session = await store.createSession(
      project.projectId,
      project.workspaceId,
      "Review",
      "elastic",
    );
  const key = randomUUID(),
    input = { prompt: "review" };
  const accepted = await measure("accept_first", () =>
    store.acceptTurn(session.sessionId, key, input),
  );
  await measure("accept_replay", () => store.acceptTurn(session.sessionId, key, input));
  const worker = await createTestWorker(db);
  const phase = { phase: "admit" };
  samples.admit = { roundTrips: 0, statements: {} };
  running = labels.run(phase, () =>
    worker
      .executor({
        execute: async () => {
          phase.phase = "backend_wait";
          entered.resolve();
          await finish.promise;
          phase.phase = "settle_with_fixture_drain";
          return { stopReason: "stop" };
        },
      })
      .dispatchRun(accepted.runId),
  );
  void running.catch(entered.reject);
  await entered.promise;
  await measure("accept_follow_up", () =>
    store.acceptTurn(session.sessionId, randomUUID(), { prompt: "pending" }),
  );
  const snapshot = await measure("queue_snapshot", () =>
    readInputQueue(db, tenant.tenantId, session.sessionId),
  );
  view = new InputQueueView({
    read: (t, s) => readInputQueue(db, t, s),
    watched: () => true,
    publish: () => {},
    unavailable: () => {},
  });
  await measure("queue_view_refresh", async () => {
    view.consume(
      {
        kind: "control_change",
        factId: randomUUID(),
        scope: { tenantId: tenant.tenantId, piSessionId: session.sessionId },
        entity: "input_queue",
        entityId: session.sessionId,
        version: snapshot.viewVersion,
        occurredAt: new Date().toISOString(),
      },
      () => true,
    );
    await view.settle();
  });
  await measure("queue_view_1000_reads", async () => {
    for (let i = 0; i < 1000; i++) assert(view.current(tenant.tenantId, session.sessionId));
  });
  const binding = {
    tenantId: tenant.tenantId,
    runId: accepted.runId,
    writerId: randomUUID(),
    bindingId: randomUUID(),
    piSessionId: session.sessionId,
    revision: "1",
    dispatchClosed: false,
    descriptor: {},
    snapshot: {},
  };
  const bindings = new SandboxBindingView({
    partitionFor: () => 0,
    partitionCount: 1,
    source: {
      loadView: async () => [binding],
      readChange: async () => binding,
      closeScope: async () => {},
      isAlive: async () => true,
    },
  });
  await bindings.load([0], () => true);
  await measure("binding_view_1000_lookups", async () => {
    for (let i = 0; i < 1000; i++)
      assert.equal(
        (
          await bindings.find(
            { tenantId: tenant.tenantId, runId: accepted.runId, writerId: binding.writerId },
            false,
          )
        ).length,
        1,
      );
  });
  await measure("accept_stop_and_pause_queue", () =>
    store.acceptTurnCancellation(session.sessionId, accepted.turnId, randomUUID(), {
      gracePeriodMs: 10000,
    }),
  );
  finish.resolve();
  await running;
  const report = {
    baseline: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    scope:
      "isolated current-schema PG and actual control methods; client round trips include BEGIN/COMMIT, exclude trigger-internal SQL; Agent backend is simulated and includes its test drain UPDATE; no HTTP authentication, Kafka, Cube or provider latency",
    samples,
  };
  await writeFile(
    process.argv[2] ?? "/tmp/pi-cloud-review-20261004/sql-roundtrips.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(
    JSON.stringify({
      scope: report.scope,
      counts: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, v.roundTrips])),
    }),
  );
} finally {
  finish.resolve();
  await running?.catch(() => {});
  await view?.close();
  Client.prototype.query = original;
  await db.destroy();
  await sql`drop database ${sql.id(name)}`.execute(admin);
  await admin.destroy();
}
