// Isolated, fixed-workload comparison for ADR-0216. Never use a production database.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { sql } from "kysely";
import { createDatabase, runMigrations } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { ControlPlaneStore } from "../packages/control-plane/src/control-plane-store.ts";
import { readInputQueue } from "../packages/control-plane/src/input-queue-snapshot.ts";
import { projectNativeSessionAppend } from "../packages/pi-session-postgres/src/project-native-session-append.ts";
const endpoint = process.env.PI_CLOUD_REVIEW_DATABASE_URL;
if (!endpoint || !["127.0.0.1", "localhost"].includes(new URL(endpoint).hostname))
  throw new Error("Provide an isolated loopback PostgreSQL URL via PI_CLOUD_REVIEW_DATABASE_URL");
const name = "review_paths_" + randomUUID().replaceAll("-", "");
const admin = createDatabase({ connectionString: endpoint, maxConnections: 1 });
await sql`create database ${sql.id(name)}`.execute(admin);
const url = new URL(endpoint);
url.pathname = "/" + name;
const db = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
const report = {
  revision: process.env.PI_CLOUD_REVIEW_REVISION ?? "working-tree",
  scope: "isolated PostgreSQL, synthetic inputs; no Kafka, model or VM latency claims",
  queues: [],
  laneHeads: [],
};
try {
  await runMigrations(db, "up");
  const tenant = await createPrivateTenant(db, {
    slug: name.replaceAll("_", "-"),
    ownerDisplayName: "Review",
  });
  const store = new ControlPlaneStore({ database: db, ...tenant });
  const p = await store.createProject({ name: "Review", source: { kind: "empty" } });
  const s = await store.createSession(p.projectId, p.workspaceId, "Review", "elastic");
  let count = 0;
  for (const size of [10, 100, 500]) {
    while (count < size) {
      await store.acceptTurn(s.sessionId, randomUUID(), { prompt: "x".repeat(4096) });
      count++;
    }
    const start = performance.now();
    const result = await readInputQueue(db, tenant.tenantId, s.sessionId);
    assert.equal(result.items.length, Math.min(size, 20));
    let page = result,
      total = page.items.length;
    while (page.hasMore) {
      page = await readInputQueue(db, tenant.tenantId, s.sessionId, {
        afterPosition: page.items.at(-1).mailboxPosition,
        viewVersion: page.viewVersion,
      });
      total += page.items.length;
    }
    assert.equal(total, size);
    report.queues.push({
      queuedInputs: size,
      visibleInputs: result.items.length,
      reachableInputs: total,
      snapshotBytes: Buffer.byteLength(JSON.stringify(result)),
      allPagesReadMs: Math.round((performance.now() - start) * 100) / 100,
    });
  }
  const native = await db
    .selectFrom("sessions")
    .select("pi_session_id")
    .where("id", "=", s.sessionId)
    .executeTakeFirstOrThrow();
  let lanes = 1;
  for (const count of [1, 101, 1001, 10001]) {
    if (count > lanes)
      await sql`insert into pi_session_lanes(tenant_id,session_id,lane,leaf_id) select ${tenant.tenantId}::uuid,${native.pi_session_id},'review-lane-'||n,null from generate_series(${lanes}::int,${count - 1}::int) n`.execute(
        db,
      );
    lanes = count;
    const row = await db
      .selectFrom("pi_sessions")
      .select("next_seq")
      .where("id", "=", native.pi_session_id)
      .executeTakeFirstOrThrow();
    let sample;
    const traced = db.withPlugin({
      transformQuery(a) {
        return a.node;
      },
      async transformResult(a) {
        for (const r of a.result.rows)
          if (Array.isArray(r.lanes))
            sample = {
              returnedLaneHeads: r.lanes.length,
              returnedHeadBytes: Buffer.byteLength(JSON.stringify(r.lanes)),
            };
        return a.result;
      },
    });
    const start = performance.now();
    await traced.transaction().execute((tx) =>
      projectNativeSessionAppend(tx, {
        tenantId: tenant.tenantId,
        sessionId: native.pi_session_id,
        appendId: randomUUID(),
        items: [{ kind: "fact", fact: "name", name: "review", seq: Number(row.next_seq) }],
      }),
    );
    report.laneHeads.push({
      storedLanes: count,
      appendItems: 1,
      ...sample,
      transactionMs: Math.round((performance.now() - start) * 100) / 100,
    });
  }
  await writeFile(
    process.env.PI_CLOUD_REVIEW_OUTPUT ?? "/tmp/pi-cloud-repair-data-paths.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  await db.destroy();
  await sql`drop database ${sql.id(name)}`.execute(admin);
  await admin.destroy();
}
