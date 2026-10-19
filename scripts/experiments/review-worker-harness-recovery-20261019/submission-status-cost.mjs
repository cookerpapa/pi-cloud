// Follow-up question: do completed Submission receipts increase cold-open work?
// Only an owned disposable PG is used. The comparison index is never deployed.
import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { sql, CompiledQuery } from "kysely";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { testPostgres } from "../../lib/test-postgres.mjs";
import { createDatabase, runMigrations } from "../../../packages/database/src/index.ts";
import {
  DurablePostgresProjection,
  PublishedDurableStorage,
} from "../../../packages/pi-session-postgres/src/durable/index.ts";

const output = resolve(process.argv[2] ?? "dist/reviews/submission-status-cost-20261019.json");
const report = {
  at: new Date().toISOString(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  scope:
    "Actual native Submission status query on consistent synthetic current receipts in owned PG; not an end-to-end recovery benchmark",
  before: [],
  comparison: [],
};
let pg, db;
const walk = (n) => [n, ...(n.Plans ?? []).flatMap(walk)];
async function fixture(count) {
  const scope = { tenantId: randomUUID(), sessionId: randomUUID() };
  await db.insertInto("tenants").values({ id: scope.tenantId, slug: scope.tenantId }).execute();
  await db
    .insertInto("pi_sessions")
    .values({ tenant_id: scope.tenantId, id: scope.sessionId })
    .execute();
  const projection = new DurablePostgresProjection(db, scope);
  const storage = await PublishedDurableStorage.open({
    projection,
    publish: (batch) => projection.apply(batch),
    waitProjected: async () => {},
  });
  await storage.commit(
    [
      { type: "conversation", value: { id: 1 } },
      {
        type: "entry",
        value: {
          id: 2,
          conversationId: 1,
          kind: "pi.user",
          model: [{ role: "user", content: "Synthetic accepted group", timestamp: 0 }],
        },
      },
      { type: "entry", value: { id: 3, conversationId: 1, kind: "pi.assistant", model: [] } },
    ],
    context,
  );
  // Shared Entry references isolate receipt-index growth from transcript size.
  for (let first = 0; first < count; first += 250)
    await storage.commit(
      Array.from({ length: Math.min(250, count - first) }, (_, i) => ({
        type: "submission",
        value: {
          id: first + i + 4,
          conversationId: 1,
          type: "input",
          requestId: "completed-" + (first + i),
          status: "done",
          entry: 2,
          answer: 3,
        },
      })),
      context,
    );
  await storage.commit(
    [
      {
        type: "submission",
        value: {
          id: count + 4,
          conversationId: 1,
          type: "input",
          requestId: "pending",
          status: "queued",
        },
      },
    ],
    context,
  );
  await storage.close(context);
  await sql`analyze pi_durable_records`.execute(db);
  await sql`analyze pi_durable_current`.execute(db);
  return scope;
}
async function measure(scope, count, status) {
  let query;
  const traced = db.withPlugin({
    transformQuery({ node, queryId }) {
      query = db.getExecutor().compileQuery(node, queryId);
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  const rows = await new DurablePostgresProjection(traced, scope).scan(
    { kind: "submission", fields: { status }, minId: 0 },
    257,
  );
  assert.equal(rows.length, status === "queued" ? 1 : 0);
  const result = await db.executeQuery(
    CompiledQuery.raw("explain (analyze,buffers,format json) " + query.sql, query.parameters),
  );
  const plan = result.rows[0]["QUERY PLAN"][0];
  const nodes = walk(plan.Plan).filter((n) => n["Relation Name"] === "pi_durable_records");
  const examined = nodes.reduce(
    (n, p) =>
      n + ((p["Actual Rows"] ?? 0) + (p["Rows Removed by Filter"] ?? 0)) * (p["Actual Loops"] ?? 1),
    0,
  );
  return {
    completedSubmissions: count,
    status,
    returned: rows.length,
    recordRowsExamined: examined,
    queryMs: plan["Execution Time"],
    nodes: nodes.map((n) => ({
      type: n["Node Type"],
      index: n["Index Name"],
      rows: n["Actual Rows"],
      removed: n["Rows Removed by Filter"] ?? 0,
      loops: n["Actual Loops"],
    })),
  };
}
try {
  report.probeSha256 = createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex");
  pg = await testPostgres({});
  db = createDatabase({ connectionString: pg.url, maxConnections: 3 });
  await runMigrations(db, "up");
  const fixtures = [];
  for (const count of [0, 1000, 10000]) {
    const scope = await fixture(count);
    fixtures.push({ scope, count });
    for (const status of ["queued", "placed"])
      report.before.push(await measure(scope, count, status));
  }
  for (const row of report.before) assert(row.recordRowsExamined >= row.completedSubmissions);
  await sql`create index review_submission_status on pi_durable_records(tenant_id,session_id,(fields->>'status'),id) where kind='submission'`.execute(
    db,
  );
  await sql`analyze pi_durable_records`.execute(db);
  for (const { scope, count } of fixtures)
    for (const status of ["queued", "placed"])
      report.comparison.push(await measure(scope, count, status));
  for (const row of report.comparison) assert(row.recordRowsExamined <= 1);
  report.comparisonIndexScope =
    "Disposable fixture only; no product migration or prepared/generic-plan acceptance";
  report.completed = true;
} finally {
  await db?.destroy();
  await pg?.close();
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
}
