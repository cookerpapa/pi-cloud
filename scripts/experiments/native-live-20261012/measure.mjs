import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { sql } from "kysely";
import { createDatabase, runMigrations } from "../../../packages/database/src/index.ts";
import { materializeNativeDocument } from "../../../packages/pi-session-postgres/src/durable/postgres-projection.ts";
import { testPostgres } from "../../lib/test-postgres.mjs";

const [mode, output] = process.argv.slice(2);
assert(["baseline", "current"].includes(mode) && output, "Use baseline|current and a report path");
const source =
  mode === "baseline"
    ? ".cache/adr0244-baseline/packages/pi-session-postgres/src/durable/postgres-projection.ts"
    : "packages/pi-session-postgres/src/durable/postgres-projection.ts";
const { DurablePostgresProjection } = await import(pathToFileURL(resolve(source)).href);
// Always isolated: do not benchmark against a caller's integration/production URL.
const fixture = await testPostgres({});
const database = createDatabase({ connectionString: fixture.url, maxConnections: 1 });
const tenantId = randomUUID(),
  sessionId = randomUUID();
const report = {
  mode,
  measuredAt: new Date().toISOString(),
  scope: "storage adapter; no provider, Kafka network or Tool execution",
  driverTransactionsCounted: false,
};
let counted = false,
  queries = 0,
  queryBytes = 0;
const measured = database.withPlugin({
  transformQuery({ node, queryId }) {
    if (counted) {
      queries++;
      queryBytes += database.getExecutor().compileQuery(node, queryId).sql.length;
    }
    return node;
  },
  async transformResult({ result }) {
    return result;
  },
});
const position = (batch) => ({
  topic: "live-measure",
  partition: 0,
  offset: BigInt(batch.seq) * 10n,
});
const payloads = async () =>
  (
    await sql`select
  (select count(*)::int from pi_durable_log where tenant_id=${tenantId}::uuid and record_id=2) as live_history_rows,
  (select coalesce(sum(octet_length(body)),0)::text from pi_durable_log where tenant_id=${tenantId}::uuid and record_id=2) as live_history_bytes,
  (select count(*)::int from pi_durable_document_revisions where tenant_id=${tenantId}::uuid and checkpoint is not null) as derived_checkpoints,
  (select coalesce(sum(octet_length(checkpoint)),0)::text from pi_durable_document_revisions where tenant_id=${tenantId}::uuid) as derived_checkpoint_bytes,
  (select coalesce(sum(octet_length(body)),0)::text from pi_durable_current where tenant_id=${tenantId}::uuid) as current_body_bytes,
  (select count(*)::int from pi_durable_commits where tenant_id=${tenantId}::uuid) as commit_headers,
  (select count(*)::int from pi_durable_current where tenant_id=${tenantId}::uuid and replay_seq is not null) as replay_references
`.execute(database)
  ).rows[0];
try {
  await runMigrations(database, "up");
  await database.insertInto("tenants").values({ id: tenantId, slug: tenantId }).execute();
  await database.insertInto("pi_sessions").values({ tenant_id: tenantId, id: sessionId }).execute();
  const scope = { tenantId, sessionId };
  const projection = new DurablePostgresProjection(measured, scope);
  const batches = [
    {
      seq: 1,
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
    },
  ];
  await projection.apply(batches[0], [], position(batches[0]));
  const before = (await sql`select pg_current_wal_insert_lsn()::text as lsn`.execute(database))
    .rows[0].lsn;
  global.gc?.();
  let peakHeap = process.memoryUsage().heapUsed;
  const start = performance.now();
  counted = true;
  const parts = [];
  for (let n = 0; n <= 1000; n++) {
    const text = createHash("sha256").update(String(n)).digest("hex").repeat(4) + "\n";
    if (n) parts.push(text);
    const batch = {
      seq: n + 2,
      nextId: 3,
      writes: [
        {
          type: "document.change",
          id: 2,
          content: {
            kind: "delta",
            version: 1,
            ops: n
              ? [["a", ["generation", "message", "text"], text]]
              : [["s", ["generation"], { attempt: 1, message: { text: "" } }]],
          },
        },
      ],
    };
    batches.push(batch);
    await projection.apply(batch, [], position(batch));
    if (n % 50 === 0) peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
  }
  counted = false;
  const durationMs = performance.now() - start;
  const wal = (
    await sql`select pg_wal_lsn_diff(pg_current_wal_insert_lsn(),${before}::pg_lsn)::text as bytes`.execute(
      database,
    )
  ).rows[0].bytes;
  report.streaming = {
    ...(await payloads()),
    changes: 1001,
    textBytes: Buffer.byteLength(parts.join("")),
    queries,
    querySqlBytes: queryBytes,
    durationMs,
    walBytes: wal,
    sampledPeakHeapBytes: peakHeap,
  };
  if (mode === "current") {
    assert.equal(report.streaming.live_history_rows, 0);
    assert.equal(report.streaming.derived_checkpoints, 0);
    assert.equal(report.streaming.replay_references, 1);
  }
  const recovery = new DurablePostgresProjection(measured, scope);
  const replayStart = performance.now();
  for (const batch of batches)
    assert.equal(await recovery.apply(batch, [], position(batch)), false);
  if (mode === "current")
    await database
      .transaction()
      .execute((tx) => recovery.checkpointLiveIn(tx, recovery.liveState.fork()));
  const record = (await recovery.get(2)).value;
  const document = materializeNativeDocument(record, await recovery.revisions(2, 1002));
  assert.equal(document.value.generation.message.text, parts.join(""));
  assert.equal(document.deltasSinceBase, 1001);
  report.recovery = {
    duplicateReplayAndColdReadMs: performance.now() - replayStart,
    exactText: true,
    exactDeltaCount: true,
    ...(await payloads()),
  };
  const final = {
    seq: 1003,
    nextId: 4,
    writes: [
      {
        type: "entry",
        value: {
          id: 3,
          conversationId: 1,
          kind: "pi.assistant",
          model: [
            {
              role: "assistant",
              content: [{ type: "text", text: parts.join("") }],
              stopReason: "stop",
              timestamp: 0,
              api: "test",
              model: "test",
              provider: "test",
            },
          ],
        },
      },
      { type: "document.change", id: 2, content: { kind: "base", version: 1, value: {} } },
    ],
  };
  await projection.apply(final, [], position(final));
  report.completed = await payloads();
  report.accepted = true;
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(
    JSON.stringify({
      mode,
      accepted: true,
      changes: 1001,
      liveHistoryRows: report.streaming.live_history_rows,
      checkpoints: report.streaming.derived_checkpoints,
      queries,
      durationMs,
      walBytes: wal,
    }),
  );
} finally {
  await database.destroy();
  await fixture.close();
}
