// Actual reader, current indexes, isolated uneven history. Not a capacity benchmark.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { sql } from "kysely";
import { testPostgres } from "../../lib/test-postgres.mjs";
import { createDatabase, runMigrations } from "../../../packages/database/src/index.ts";
import { createPrivateTenant } from "../../../packages/control-plane/src/tenant-administration.ts";
import { ControlPlaneStore } from "../../../packages/control-plane/src/control-plane-store.ts";
import { ConversationReader } from "../../../packages/control-plane/src/conversation-reader.ts";

const fixture = await testPostgres({});
const db = createDatabase({ connectionString: fixture.url, maxConnections: 2 });
const { Client } = pg;
let bench, connection;
const output = {
  scope:
    "Isolated PostgreSQL with copied current tables/indexes; no fixture foreign keys or production load",
  sessionCount: 5000,
  historyDistribution: "Every 97th Session has 1000 Turns; the others have ordinal modulo 7",
  pages: [],
};
try {
  await runMigrations(db, "up");
  const tenant = await createPrivateTenant(db, {
    slug: "r2-list-" + randomUUID(),
    ownerDisplayName: "Review fixture",
  });
  const store = new ControlPlaneStore({ database: db, ...tenant });
  const project = await store.createProject({ name: "Review", source: { kind: "empty" } });
  const session = await store.createSession(
    project.projectId,
    project.workspaceId,
    "Fixture",
    "elastic",
  );
  await store.acceptTurn(session.sessionId, randomUUID(), { prompt: "Fixture" });
  await sql.raw("create schema bench").execute(db);
  for (const name of ["projects", "workspaces", "sessions", "turns"])
    await sql.raw(`create table bench.${name} (like public.${name} including all)`).execute(db);
  for (const name of ["projects", "workspaces"])
    await sql.raw(`insert into bench.${name} select * from public.${name}`).execute(db);
  await sql
    .raw(
      `insert into bench.sessions select r.* from public.sessions s
    cross join generate_series(1,5000) n cross join lateral jsonb_populate_record(null::bench.sessions,
      to_jsonb(s)||jsonb_build_object('id',gen_random_uuid(),'pi_session_id',gen_random_uuid(),
      'title',n::text,'last_active_at','2026-10-07T00:00:00Z'::timestamptz-n*interval '1 microsecond')) r`,
    )
    .execute(db);
  await sql
    .raw(
      `insert into bench.turns select r.* from public.turns t cross join bench.sessions s
    cross join lateral generate_series(1,case when s.title::integer%97=0 then 1000 else s.title::integer%7 end) n
    cross join lateral jsonb_populate_record(null::bench.turns,to_jsonb(t)||jsonb_build_object(
      'id',gen_random_uuid(),'session_id',s.id,'idempotency_key',gen_random_uuid()::text,
      'mailbox_position',n,'state','completed','started_at',now(),'settled_at',now(),'stop_reason','stop')) r`,
    )
    .execute(db);
  for (const name of ["projects", "workspaces", "sessions", "turns"])
    await sql.raw(`analyze bench.${name}`).execute(db);
  const url = new URL(fixture.url);
  url.searchParams.set("options", "-c search_path=bench,public");
  bench = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
  connection = new Client({ connectionString: url.toString() });
  await connection.connect();
  output.totalTurns = Number(
    (await connection.query("select count(*) from bench.turns")).rows[0].count,
  );
  const reader = new ConversationReader(bench, tenant.tenantId);
  const visits = (node, relation) =>
    (node["Relation Name"] === relation ? node["Actual Rows"] * node["Actual Loops"] : 0) +
    (node.Plans ?? []).reduce((n, child) => n + visits(child, relation), 0);
  for (const preceding of [0, 2400, 4800]) {
    const position =
      preceding === 0
        ? undefined
        : (
            await connection.query(
              `select id, to_char(last_active_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at
       from bench.sessions where title=$1`,
              [String(preceding)],
            )
          ).rows[0];
    const cursor = position
      ? Buffer.from(JSON.stringify(position)).toString("base64url")
      : undefined;
    let captured;
    const original = Client.prototype.query;
    Client.prototype.query = function (...args) {
      const text = typeof args[0] === "string" ? args[0] : args[0]?.text;
      if (text?.startsWith("select ") && text.includes('as "turnCount"'))
        captured = { text, parameters: args[0]?.values ?? args[1] ?? [] };
      return original.apply(this, args);
    };
    let result;
    try {
      result = await reader.listConversations(cursor);
    } finally {
      Client.prototype.query = original;
    }
    assert(captured);
    assert.equal(result.conversations.length, 100);
    assert(result.nextCursor);
    assert.deepEqual(
      result.conversations.map((r) => Number(r.title)),
      Array.from({ length: 100 }, (_, i) => preceding + i + 1),
    );
    for (const row of result.conversations) {
      const n = Number(row.title);
      assert.equal(row.turnCount, n % 97 === 0 ? 1000 : n % 7);
    }
    const plan = (
      await connection.query(
        "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + captured.text,
        captured.parameters,
      )
    ).rows[0]["QUERY PLAN"][0];
    const expectedPageTurns = Array.from({ length: 101 }, (_, i) => preceding + i + 1).reduce(
      (n, id) => n + (id % 97 === 0 ? 1000 : id % 7),
      0,
    );
    // EXPLAIN reports rounded per-loop Actual Rows, so permit that reporting error.
    assert(Math.abs(visits(plan.Plan, "turns") - expectedPageTurns) <= 101);
    assert.equal(visits(plan.Plan, "sessions"), 101);
    output.pages.push({
      preceding,
      visibleRows: 100,
      pageTurns: expectedPageTurns,
      sessionRowsVisited: visits(plan.Plan, "sessions"),
      turnRowsReported: visits(plan.Plan, "turns"),
      executionMs: plan["Execution Time"],
      plan,
    });
  }
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(output, null, 2));
  console.log(
    JSON.stringify({
      totalTurns: output.totalTurns,
      pages: output.pages.map(({ plan, ...rest }) => rest),
    }),
  );
} finally {
  await connection?.end();
  await bench?.destroy();
  await db.destroy();
  await fixture.close();
}
