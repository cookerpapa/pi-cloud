// Indexed-read regression evidence. Creates and destroys an isolated PostgreSQL container.
// LIKE clones retain columns/checks/indexes, but omit FKs/triggers for synthetic history.
// Run from a clean checkout: node --import tsx scripts/experiments/review-worker-claim-20261010/probe.mjs
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs";
import { Pool } from "pg";
import { testPostgres } from "../../../scripts/lib/test-postgres.mjs";
import { createDatabase, runMigrations } from "../../../packages/database/src/index.ts";
import { ControlPlaneStore } from "../../../packages/control-plane/src/control-plane-store.ts";
import { createPrivateTenant } from "../../../packages/control-plane/src/tenant-administration.ts";
import { RunExecutor } from "../../../packages/runtime-core/src/run-executor.ts";

const fixture = await testPostgres({});
const db = createDatabase({ connectionString: fixture.url, maxConnections: 3 });
const pool = new Pool({ connectionString: fixture.url, max: 1 });
const report = {
  scope:
    "isolated migrated PG; synthetic history in LIKE clones preserving columns, checks and indexes; no production mutations",
};
try {
  await runMigrations(db, "up");
  report.version = (await pool.query("select version()")).rows[0].version;
  const tenant = await createPrivateTenant(db, {
    slug: randomUUID(),
    ownerDisplayName: "Claim schema review",
  });
  const store = new ControlPlaneStore({ database: db, ...tenant });
  const workspace = await store.createProject({
    name: "Claim schema review",
    source: { kind: "empty" },
  });
  const session = await store.createSession(
    workspace.projectId,
    workspace.workspaceId,
    "Review",
    "elastic",
  );
  const accepted = await store.acceptTurn(session.sessionId, randomUUID(), {
    prompt: "Schema review fixture",
  });
  const worker = randomUUID();
  await db
    .insertInto("workers")
    .values({
      id: worker,
      supervisor_id: worker,
      boot_id: randomUUID(),
      state: "ready",
      max_concurrent_sessions: 2,
    })
    .execute();
  let candidate;
  const measured = db.withPlugin({
    transformQuery({ node, queryId }) {
      const q = db.getExecutor().compileQuery(node, queryId);
      if (q.sql.includes("claim_candidate")) candidate = q;
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  const sentinel = new Error("review ends before admission writes");
  const executor = new RunExecutor({
    database: measured,
    workerId: worker,
    backend: {
      async admit() {
        throw sentinel;
      },
      async execute() {
        throw new Error("unexpected execution");
      },
    },
    executionAuthority: {},
  });
  try {
    await executor.dispatchNext();
  } catch (e) {
    if (e !== sentinel) throw e;
  }
  if (!candidate) throw new Error("candidate SQL was not captured");
  await pool.query(`create schema review_plan;
    create table review_plan.subagent_executions (like public.subagent_executions including all);
    create table review_plan.run_transitions (like public.run_transitions including all);
    insert into review_plan.subagent_executions
      (id,tenant_id,parent_session_id,parent_run_id,parent_tool_call_id,workflow_run_id,step_index,request_sha256,
       child_session_id,child_run_id,agent_name,context_mode,sandbox_mode,state,settled_at,root_session_id,root_run_id,depth)
    select md5('execution'||n)::uuid,md5('tenant'||(n%100))::uuid,md5('parent_session'||n)::uuid,md5('parent_run'||n)::uuid,
      'tool-'||n,'workflow-'||n,0,repeat('a',64),md5('child_session'||n)::uuid,md5('child_run'||n)::uuid,
      'child','fresh','none','completed',clock_timestamp(),md5('root_session'||n)::uuid,md5('root_run'||n)::uuid,1
      from generate_series(1,50000) n;
    insert into review_plan.run_transitions(id,tenant_id,run_id,from_state,to_state,reason)
      select md5('transition'||n)::uuid,md5('tenant'||((n-1)/5%100))::uuid,md5('run'||((n-1)/5))::uuid,
        'queued','running','execution_admitted' from generate_series(1,100000) n;
    analyze review_plan.subagent_executions;
    analyze review_plan.run_transitions;`);
  await pool.query(
    `insert into review_plan.run_transitions(id,tenant_id,run_id,from_state,to_state,reason)
    select gen_random_uuid(),$1,$2,'queued','running','execution_admitted' from generate_series(1,5)`,
    [tenant.tenantId, accepted.runId],
  );
  const plan = async (query, parameters = []) =>
    (await pool.query("explain (analyze,buffers,format json) " + query, parameters)).rows[0][
      "QUERY PLAN"
    ][0];
  const indexedClaim = candidate.sql.replace(
    "from subagent_executions e",
    "from review_plan.subagent_executions e",
  );
  const claim = indexedClaim.replace(/e\.tenant_id="candidate"\."tenant_id"\s+and /, "");
  if (indexedClaim === candidate.sql || claim === indexedClaim)
    throw new Error("probe SQL replacement failed");
  report.claim = {
    rows: 50000,
    before: await plan(claim, candidate.parameters),
    after: await plan(indexedClaim, candidate.parameters),
  };
  assert.equal(report.claim.before.Plan["Actual Rows"], 1);
  assert.equal(report.claim.after.Plan["Actual Rows"], 1);
  const history =
    "select id,run_id,from_state,to_state,reason,occurred_at from review_plan.run_transitions where tenant_id=$1 and run_id=$2 order by occurred_at,id";
  const indexedHistory = await plan(history, [tenant.tenantId, accepted.runId]);
  const clonedIndexes = await pool.query(
    "select format('drop index %I.%I',schemaname,indexname) as ddl from pg_indexes where schemaname='review_plan' and tablename='run_transitions' and indexdef like '%(tenant_id, run_id, occurred_at, id)%'",
  );
  assert.equal(clonedIndexes.rows.length, 1);
  await pool.query(clonedIndexes.rows[0].ddl);
  report.transitions = {
    rows: 100005,
    before: await plan(history, [tenant.tenantId, accepted.runId]),
  };
  report.transitions.after = indexedHistory;
  assert.equal(report.transitions.before.Plan["Actual Rows"], 5);
  assert.equal(report.transitions.after.Plan["Actual Rows"], 5);
  const columns = await pool.query(
    "select column_name from information_schema.columns where table_schema='public' and table_name='pi_sessions'",
  );
  report.removedMetadata = ["created_at_ms", "parent_session_id", "name"].map((column) => ({
    column,
    absent: !columns.rows.some((row) => row.column_name === column),
  }));
  assert.ok(report.removedMetadata.every((row) => row.absent));
  const output = new URL("../../../dist/reviews/worker-claim-20261010/probe.json", import.meta.url);
  fs.mkdirSync(new URL(".", output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2) + "\n");
  const scans = (node, out = []) => {
    if (node["Relation Name"])
      out.push({
        node: node["Node Type"],
        table: node["Relation Name"],
        index: node["Index Name"],
        rows: node["Actual Rows"],
        removed: node["Rows Removed by Filter"],
        blocks: (node["Shared Hit Blocks"] ?? 0) + (node["Shared Read Blocks"] ?? 0),
        indexCondition: node["Index Cond"],
      });
    for (const p of node.Plans ?? []) scans(p, out);
    return out;
  };
  const childRead = scans(report.claim.after.Plan).find(
    (row) => row.table === "subagent_executions",
  );
  const historyRead = scans(report.transitions.after.Plan).find(
    (row) => row.table === "run_transitions",
  );
  assert.match(childRead.indexCondition, /tenant_id.*child_run_id/);
  assert.ok(childRead.blocks < 32, "Child lookup must stay bounded as unrelated history grows");
  assert.equal(historyRead.rows, 5);
  assert.ok(historyRead.blocks < 32, "Run history lookup must avoid unrelated history");
  for (const [name, pair] of Object.entries({
    claim: report.claim,
    transitions: report.transitions,
  }))
    for (const label of ["before", "after"])
      console.log(
        JSON.stringify({
          name,
          label,
          ms: pair[label]["Execution Time"],
          scans: scans(pair[label].Plan),
        }),
      );
  console.log(JSON.stringify({ version: report.version, removedMetadata: report.removedMetadata }));
} finally {
  await db.destroy();
  await pool.end();
  await fixture.close();
}
