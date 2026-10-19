import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { CompiledQuery, sql } from "kysely";
import { testPostgres } from "../../lib/test-postgres.mjs";
import { createDatabase, runMigrations } from "../../../packages/database/src/index.ts";
import { DurablePostgresProjection } from "../../../packages/pi-session-postgres/src/durable/postgres-projection.ts";
import { projectionTransaction } from "../../../packages/runtime-core/src/projection-transaction.ts";

// Always disposable. This is a query-scaling fixture, not a model/Agent workload.
const fixture = await testPostgres({});
const database = createDatabase({ connectionString: fixture.url, maxConnections: 1 });
const cases = [];
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const walk = (plan) => [plan, ...(plan.Plans ?? []).flatMap(walk)];
try {
  await runMigrations(database, "up");
  for (const priorHeaders of [1, 1000, 10000, 50000]) {
    const tenantId = randomUUID(),
      sessionId = randomUUID();
    await database.insertInto("tenants").values({ id: tenantId, slug: tenantId }).execute();
    await database
      .insertInto("pi_sessions")
      .values({ tenant_id: tenantId, id: sessionId })
      .execute();
    // Prior no-op headers use the actual immutable-batch fingerprint. They are
    // bulk loaded to isolate the checkpoint query from publication/ingest cost.
    const headers = Array.from({ length: priorHeaders }, (_, index) => {
      const batch = { seq: index + 1, nextId: 2, writes: [] };
      return { seq: batch.seq, fingerprint: hash({ batch, origins: [] }) };
    });
    await sql`insert into pi_durable_commits
      (tenant_id,session_id,seq,next_id,fingerprint,write_count,history_write_count,history_fingerprint,current_hashes)
      select ${tenantId}::uuid,${sessionId},x.seq,2,x.fingerprint,0,0,${hash([])},'{}'::jsonb
      from jsonb_to_recordset(${JSON.stringify(headers)}::jsonb) x(seq bigint,fingerprint text)`.execute(
      database,
    );
    let proofQuery;
    const measured = database.withPlugin({
      transformQuery({ node, queryId }) {
        const compiled = database.getExecutor().compileQuery(node, queryId);
        if (compiled.sql.includes("select distinct on (h.key)")) proofQuery = compiled;
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    const view = new DurablePostgresProjection(measured, { tenantId, sessionId });
    const seed = {
      seq: priorHeaders + 1,
      nextId: 3,
      writes: [
        { type: "conversation", value: { id: 1 } },
        {
          type: "document.create",
          record: {
            id: 2,
            kind: "pi.live",
            scope: { kind: "conversation", conversationId: 1 },
            history: "latest",
            fork: "initial",
          },
          content: { kind: "base", version: 1, value: {} },
        },
      ],
    };
    const progress = {
      seq: priorHeaders + 2,
      nextId: 3,
      writes: [
        {
          type: "document.change",
          id: 2,
          content: {
            kind: "delta",
            version: 1,
            ops: [
              ["s", ["generation"], { attempt: 1, message: { text: "one recent pending change" } }],
            ],
          },
        },
      ],
    };
    const position = (batch) => ({
      topic: "checkpoint-cost",
      partition: 0,
      offset: BigInt(batch.seq),
    });
    await view.apply(seed, [], position(seed));
    await view.apply(progress, [], position(progress));
    await sql`analyze pi_durable_commits`.execute(database);
    const start = performance.now();
    await projectionTransaction(measured, (tx) => view.checkpointLiveIn(tx, view.liveState.fork()));
    const checkpointMs = performance.now() - start;
    assert(proofQuery);
    const result = await database.executeQuery(
      CompiledQuery.raw(
        `explain (analyze, buffers, format json) ${proofQuery.sql}`,
        proofQuery.parameters,
      ),
    );
    const explain = result.rows[0]["QUERY PLAN"][0];
    const nodes = walk(explain.Plan);
    const scannedHeaders = nodes
      .filter((node) => node["Relation Name"] === "pi_durable_commits")
      .reduce((sum, node) => sum + node["Actual Rows"] * node["Actual Loops"], 0);
    assert.equal(scannedHeaders, priorHeaders + 2);
    await view.assertComplete();
    assert.equal(
      (await view.revisions(2, progress.seq))[0].checkpoint.generation.message.text,
      "one recent pending change",
    );
    cases.push({
      priorHeaders,
      pendingDocuments: 1,
      pendingChanges: 1,
      scannedHeaders,
      returnedProofs: explain.Plan["Actual Rows"],
      queryExecutionMs: explain["Execution Time"],
      checkpointMs: +checkpointMs.toFixed(3),
      sharedHitBlocks: explain.Plan["Shared Hit Blocks"],
      sharedReadBlocks: explain.Plan["Shared Read Blocks"],
      planNodes: nodes.map((node) => ({
        type: node["Node Type"],
        relation: node["Relation Name"],
        rows: node["Actual Rows"],
        loops: node["Actual Loops"],
      })),
    });
  }
  const report = {
    measuredAt: new Date().toISOString(),
    scope:
      "owned loopback PG, actual checkpoint query; bulk-loaded consistent no-op historical headers",
    limitation:
      "One pending document/change. No claim about production latency, an observed timeout, fleet capacity or real Harness ingestion.",
    cases,
  };
  await writeFile(
    process.argv[2] ?? "/tmp/pi-cloud-seal-checkpoint-cost.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  await database.destroy();
  await fixture.close();
}
