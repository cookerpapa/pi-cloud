// Isolated PG: actual repaired reader versus the recorded review query. Timing is illustrative.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import pg from "pg";
const { Client } = pg;
import { sql } from "kysely";
import { testPostgres } from "../../../scripts/lib/test-postgres.mjs";
import { createDatabase, runMigrations } from "../../../packages/database/src/index.ts";
import { createPrivateTenant } from "../../../packages/control-plane/src/tenant-administration.ts";
import { ControlPlaneStore } from "../../../packages/control-plane/src/control-plane-store.ts";
import { ConversationReader } from "../../../packages/control-plane/src/conversation-reader.ts";
const outputPath = process.argv[2];
const fixture = await testPostgres({});
const db = createDatabase({ connectionString: fixture.url, maxConnections: 2 });
let bench;
const output = { sessionCount: 5000, turnsPerSession: 40, measurements: [] };
try {
  await runMigrations(db, "up");
  const tenant = await createPrivateTenant(db, {
    slug: "list-review-" + randomUUID(),
    ownerDisplayName: "Isolated list query review",
  });
  const store = new ControlPlaneStore({ database: db, ...tenant });
  const project = await store.createProject({ name: "Review fixture", source: { kind: "empty" } });
  const session = await store.createSession(
    project.projectId,
    project.workspaceId,
    "Fixture",
    "elastic",
  );
  await store.acceptTurn(session.sessionId, randomUUID(), { prompt: "Fixture" });
  await sql.raw("create schema bench").execute(db);
  for (const name of ["projects", "workspaces", "sessions", "turns"]) {
    await sql.raw(`create table bench.${name} (like public.${name} including all)`).execute(db);
  }
  for (const name of ["projects", "workspaces"])
    await sql.raw(`insert into bench.${name} select * from public.${name}`).execute(db);
  await sql
    .raw(
      `insert into bench.sessions select r.* from public.sessions s cross join generate_series(1,5000) n cross join lateral jsonb_populate_record(null::bench.sessions,to_jsonb(s)||jsonb_build_object('id',gen_random_uuid(),'pi_session_id',gen_random_uuid(),'last_active_at',now()-n*interval '1 second')) r`,
    )
    .execute(db);
  await sql
    .raw(
      `insert into bench.turns select r.* from public.turns t cross join bench.sessions s cross join generate_series(1,40) n cross join lateral jsonb_populate_record(null::bench.turns,to_jsonb(t)||jsonb_build_object('id',gen_random_uuid(),'session_id',s.id,'idempotency_key',gen_random_uuid()::text,'mailbox_position',n,'state','completed','started_at',now(),'settled_at',now(),'stop_reason','stop')) r`,
    )
    .execute(db);
  for (const name of ["projects", "workspaces", "sessions", "turns"])
    await sql.raw(`analyze bench.${name}`).execute(db);
  const url = new URL(fixture.url);
  url.searchParams.set("options", "-c search_path=bench,public");
  bench = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
  const original = Client.prototype.query;
  let captured;
  Client.prototype.query = function (...args) {
    const text = typeof args[0] === "string" ? args[0] : args[0]?.text;
    if (text?.startsWith("select ") && text.includes('as "turnCount"'))
      captured = { text, parameters: args[0]?.values ?? args[1] ?? [] };
    return original.apply(this, args);
  };
  try {
    await new ConversationReader(bench, tenant.tenantId).listConversations();
  } finally {
    Client.prototype.query = original;
  }
  if (!captured) throw Error("Query not captured");
  const conn = new Client({ connectionString: url.toString() });
  await conn.connect();
  try {
    for (let n = 0; n < 3; n++) {
      const result = await conn.query(
        "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + captured.text,
        captured.parameters,
      );
      output.measurements.push(result.rows[0]["QUERY PLAN"][0]);
    }
    output.query = captured.text;
    const historical = JSON.parse(
      await readFile(
        new URL("../../../docs/reports/repository-review-20261007.json", import.meta.url),
        "utf8",
      ),
    ).probes.conversationListInitial;
    const baselineParameters = ["queued", tenant.tenantId, "conversation", 101];
    output.baselineQuery = historical.query;
    output.baselineMeasurements = [];
    for (let n = 0; n < 3; n++)
      output.baselineMeasurements.push(
        (
          await conn.query(
            "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) " + historical.query,
            baselineParameters,
          )
        ).rows[0]["QUERY PLAN"][0],
      );
    const actual = (await conn.query(captured.text, captured.parameters)).rows;
    const previous = (await conn.query(historical.query, baselineParameters)).rows;
    output.sameRows = JSON.stringify(actual) === JSON.stringify(previous);
    assert(output.sameRows, "Conversation results changed");
    const turnRows = (node) =>
      (node["Relation Name"] === "turns" ? node["Actual Rows"] * node["Actual Loops"] : 0) +
      (node.Plans ?? []).reduce((n, child) => n + turnRows(child), 0);
    output.turnRowsVisited = turnRows(output.measurements.at(-1).Plan);
    assert.equal(
      output.turnRowsVisited,
      101 * output.turnsPerSession,
      "Count only the selected page's Turns",
    );

    output.indexes = (
      await conn.query(
        "select tablename,indexdef from pg_indexes where schemaname='bench' and tablename in ('sessions','turns') order by tablename,indexname",
      )
    ).rows;
  } finally {
    await conn.end();
  }
  if (outputPath) await writeFile(outputPath, JSON.stringify(output, null, 2));
  console.log(
    JSON.stringify({
      sameRows: output.sameRows,
      currentMs: output.measurements.map((p) => p["Execution Time"]),
      baselineMs: output.baselineMeasurements.map((p) => p["Execution Time"]),
      turnRowsVisited: output.turnRowsVisited,
    }),
  );
} finally {
  await bench?.destroy();
  await db.destroy();
  await fixture.close();
}
