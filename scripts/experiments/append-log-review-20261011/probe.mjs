// Read-only product review: all mutations below use an owned disposable PG and temp files.
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import { sql } from "kysely";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider, fauxAssistantMessage } from "@earendil-works/pi-ai/providers/faux";
import { testPostgres } from "../../lib/test-postgres.mjs";
import { createDatabase, runMigrations } from "../../../packages/database/src/index.ts";
import { PublishedDurableStorage } from "../../../packages/pi-session-postgres/src/durable/published-storage.ts";
import { DurablePostgresProjection } from "../../../packages/pi-session-postgres/src/durable/postgres-projection.ts";

const output = resolve(process.argv[2] ?? "dist/reviews/append-log-20261011/probe.json");
const directory = await mkdtemp(join(tmpdir(), "pi-cloud-log-review-"));
let postgres, database;
const report = {
  checkedAt: new Date().toISOString(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  piVersion: "1.0.0",
  probeSha256: createHash("sha256")
    .update(await readFile(fileURLToPath(import.meta.url)))
    .digest("hex"),
  scope:
    "Isolated storage contracts and retention; no Kafka, provider network, sandbox or production mutation.",
  synthetic: {},
  nativeStreaming: {},
  rebuild: {},
  coldDocument: {},
};
const text = (label, bytes) => {
  let result = "";
  for (let n = 0; result.length < bytes; n++)
    result += createHash("sha256").update(`${label}:${n}`).digest("hex");
  return result.slice(0, bytes);
};
const task = (state) => ({
  id: 2,
  conversationId: 1,
  kind: "review.task",
  version: 1,
  input: {},
  background: false,
  abortRequested: false,
  state,
});
const stable = (value) =>
  JSON.stringify(value, (_, item) =>
    item && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
async function pgFixture() {
  const tenantId = randomUUID(),
    sessionId = randomUUID();
  await database.insertInto("tenants").values({ id: tenantId, slug: tenantId }).execute();
  await database.insertInto("pi_sessions").values({ tenant_id: tenantId, id: sessionId }).execute();
  const projection = new DurablePostgresProjection(database, { tenantId, sessionId });
  const batches = [];
  const store = await PublishedDurableStorage.open({
    projection,
    publish: async (batch) => {
      batches.push(structuredClone(batch));
      await projection.apply(batch);
    },
    waitProjected: async (through) => assert((await projection.head()).seq >= through),
  });
  return { store, projection, batches, tenantId, sessionId };
}
async function pgStats(f) {
  const groups = await sql`select record_kind,phase,count(*)::int as rows,
    sum(octet_length(body))::bigint::text as body_bytes from pi_durable_log
    where tenant_id=${f.tenantId}::uuid and session_id=${f.sessionId}
    group by record_kind,phase order by record_kind,phase`.execute(database);
  const sizes = await sql`select relname,pg_total_relation_size(oid)::text as total_bytes
    from pg_class where relname in ('pi_durable_log','pi_durable_commits','pi_durable_records','pi_durable_document_revisions')
    and relnamespace='public'::regnamespace order by relname`.execute(database);
  const rows = await sql`select
    (select count(*) from pi_durable_commits where tenant_id=${f.tenantId}::uuid and session_id=${f.sessionId})::int as commits,
    (select count(*) from pi_durable_records where tenant_id=${f.tenantId}::uuid and session_id=${f.sessionId})::int as records,
    (select count(*) from pi_durable_document_revisions where tenant_id=${f.tenantId}::uuid and session_id=${f.sessionId})::int as revisions`.execute(
    database,
  );
  return {
    ...rows.rows[0],
    groups: groups.rows,
    relationSizesWholeFixture: sizes.rows,
    maxBatchJsonBytes: Math.max(0, ...f.batches.map((b) => Buffer.byteLength(JSON.stringify(b)))),
  };
}
async function fileBytes(path) {
  const metadata = await stat(path);
  if (metadata.isFile()) return metadata.size;
  return (
    await Promise.all((await readdir(path)).map((name) => fileBytes(join(path, name))))
  ).reduce((a, b) => a + b, 0);
}
async function exerciseSnapshots(store) {
  await store.commit(
    [
      { type: "conversation", value: { id: 1 } },
      { type: "task", value: task({ status: "pending", checkpoint: { n: -1 } }) },
      {
        type: "document.create",
        record: { id: 3, kind: "review.latest", scope: { kind: "session" } },
        content: { kind: "base", version: 1, value: { counter: 0 } },
      },
    ],
    context,
  );
  const payload = text("checkpoint", 16384);
  for (let n = 0; n < 128; n++)
    await store.commit(
      [
        { type: "task", value: task({ status: "running", checkpoint: { n, payload } }) },
        {
          type: "document.change",
          id: 3,
          content: { kind: "delta", version: 1, ops: [["s", ["counter"], n + 1]] },
        },
      ],
      context,
    );
  await store.commit(
    [
      {
        type: "task",
        value: task({ status: "terminal", outcome: { status: "completed", result: "done" } }),
      },
      {
        type: "document.change",
        id: 3,
        content: { kind: "base", version: 1, value: { counter: 128 } },
      },
    ],
    context,
  );
  assert.equal((await store.task(2, context)).state.status, "terminal");
  assert.deepEqual((await store.document(3, "current", context)).value, { counter: 128 });
}
async function coldDocumentProbe(f, reuseScannedHeader) {
  const measurement = { queries: 0, returnedBodyBytes: 0, returnedCheckpointBytes: 0 };
  const measured = database.withPlugin({
    transformQuery({ node }) {
      measurement.queries++;
      return node;
    },
    async transformResult({ result }) {
      for (const row of result.rows) {
        if (typeof row.body === "string")
          measurement.returnedBodyBytes += Buffer.byteLength(row.body);
        if (typeof row.checkpoint === "string")
          measurement.returnedCheckpointBytes += Buffer.byteLength(row.checkpoint);
      }
      return result;
    },
  });
  const projection = new DurablePostgresProjection(measured, f.projection.scope);
  if (reuseScannedHeader) {
    // Experiment only: reuse the already-returned metadata during this one cold read.
    // This is not a replacement implementation or a product cache change.
    const found = new Map(),
      scan = projection.scan.bind(projection),
      get = projection.get.bind(projection);
    projection.scan = async (...args) => {
      const records = await scan(...args);
      for (const record of records)
        if (record.kind === "document") found.set(record.value.id, record);
      return records;
    };
    projection.get = async (id) => found.get(id) ?? get(id);
  }
  const store = await PublishedDurableStorage.open({
    projection,
    publish: async () => {
      throw new Error("Read-only probe");
    },
    waitProjected: async () => {},
  });
  measurement.queries = 0;
  const record = await store.findDocument(
    { kind: "review.large", scope: { kind: "session" } },
    "current",
    context,
  );
  const document = await store.document(record.id, "current", context);
  assert.equal(document.value.text, text("large-document", 512 * 1024));
  await store.close(context);
  return measurement;
}
async function snapshotIndex(f) {
  const r =
    await sql`select * from pi_durable_records where tenant_id=${f.tenantId}::uuid and session_id=${f.sessionId} order by id`.execute(
      database,
    );
  const d =
    await sql`select * from pi_durable_document_revisions where tenant_id=${f.tenantId}::uuid and session_id=${f.sessionId} order by document_id,seq`.execute(
      database,
    );
  return stable({ records: r.rows, documents: d.rows });
}
async function nativeStreaming(store) {
  const models = createModels(),
    faux = fauxProvider({ tokensPerSecond: 20, tokenSize: { min: 64, max: 64 } });
  models.setProvider(faux.provider);
  const answer = text("native-stream", 16384);
  faux.setResponses([fauxAssistantMessage(answer)]);
  const harness = await Harness.open(
    store,
    {
      models,
      registry: createRegistry(),
      settings: { compaction: { enabled: false }, retry: { maxRetries: 0 } },
    },
    context,
  );
  try {
    const model = faux.getModel();
    const root = await harness.root(context, {
      agent: { model: { provider: model.provider, modelId: model.id } },
    });
    const submitted = await root.submit(
      { type: "input", content: "Return the scripted fixture.", requestId: "review-stream" },
      context,
    );
    assert.equal((await submitted.wait(context)).status, "done");
    await root.waitForIdle(context);
    const result = await root.context(context);
    assert(
      result.messages.some(
        (m) =>
          m.role === "assistant" && m.content.some((c) => c.type === "text" && c.text === answer),
      ),
    );
    return {
      answerBytes: Buffer.byteLength(answer),
      contextBytes: Buffer.byteLength(JSON.stringify(result.messages)),
      modelCalls: faux.state.callCount,
    };
  } finally {
    await harness.close(context);
  }
}

try {
  postgres = await testPostgres({}); // Never accept an inherited integration URL.
  database = createDatabase({ connectionString: postgres.url, maxConnections: 4 });
  await runMigrations(database, "up");
  const f = await pgFixture();
  await exerciseSnapshots(f.store);
  await f.store.flush();
  report.synthetic.piCloud = await pgStats(f);
  const before = await snapshotIndex(f);
  await f.store.close(context);
  await f.projection.rebuild();
  report.rebuild.validIndexMatches = before === (await snapshotIndex(f));
  assert(report.rebuild.validIndexMatches);
  report.rebuild.duplicateAcceptedAsNoop = (await f.projection.apply(f.batches.at(-1))) === false;
  const conflicting = structuredClone(f.batches.at(-1));
  conflicting.writes[0].value.state.outcome.result = "different";
  await assert.rejects(f.projection.apply(conflicting), /changed bytes/);
  report.rebuild.conflictingBatchRejected = true;

  const jsonlPath = join(directory, "jsonl");
  const jsonl = await openNodeJsonlStorage(jsonlPath, context, { fsync: true });
  await exerciseSnapshots(jsonl);
  await jsonl.close(context);
  const jsonlNames = await readdir(jsonlPath);
  report.synthetic.piJsonl = {
    bytes: await fileBytes(jsonlPath),
    files: jsonlNames,
    remainingTaskCheckpointBytes: jsonlNames.includes("task-2.jsonl")
      ? (await stat(join(jsonlPath, "task-2.jsonl"))).size
      : 0,
  };
  const sqlitePath = join(directory, "sqlite.db");
  const sqlite = await openNodeSqliteStorage(sqlitePath);
  await exerciseSnapshots(sqlite);
  await sqlite.close(context);
  const sqliteDb = new DatabaseSync(sqlitePath, { readOnly: true });
  try {
    report.synthetic.piSqlite = {
      fileBytes: await fileBytes(sqlitePath),
      tasks: sqliteDb
        .prepare("select count(*) as rows,sum(length(record)) as body_bytes from tasks")
        .get(),
      documentRevisions: sqliteDb
        .prepare(
          "select count(*) as rows,sum(length(content)) as body_bytes from document_revisions",
        )
        .get(),
    };
  } finally {
    sqliteDb.close();
  }

  const stream = await pgFixture();
  report.nativeStreaming.piCloud = await nativeStreaming(stream.store);
  report.nativeStreaming.piCloud.storage = await pgStats(stream);

  const large = await pgFixture();
  await large.store.commit(
    [
      {
        type: "document.create",
        record: { id: 2, kind: "review.large", scope: { kind: "session" } },
        content: { kind: "base", version: 1, value: { text: text("large-document", 512 * 1024) } },
      },
    ],
    context,
  );
  await large.store.flush();
  await large.store.close(context);
  report.coldDocument.current = await coldDocumentProbe(large, false);
  report.coldDocument.reuseScannedHeaderPrototype = await coldDocumentProbe(large, true);
  assert.equal(report.coldDocument.current.queries, 3);
  assert.equal(report.coldDocument.reuseScannedHeaderPrototype.queries, 2);

  // Controlled corruption, deliberately limited to this disposable database.
  // A removed entry-only commit leaves its header and the preceding valid commit.
  const missing = await pgFixture();
  await missing.store.commit([{ type: "conversation", value: { id: 1 } }], context);
  await missing.store.commit(
    [
      {
        type: "entry",
        value: { id: 2, conversationId: 1, kind: "review", data: { text: "must-survive" } },
      },
    ],
    context,
  );
  await missing.store.close(context);
  await sql`delete from pi_durable_log where tenant_id=${missing.tenantId}::uuid and session_id=${missing.sessionId} and seq=2`.execute(
    database,
  );
  try {
    await missing.projection.rebuild();
    report.rebuild.missingBodyRejected = false;
  } catch (error) {
    report.rebuild.missingBodyRejected = true;
    report.rebuild.missingBodyError = error.message;
  }
  report.rebuild.missingBodyHeader = (
    await sql`select seq,write_count,(select count(*) from pi_durable_log l where l.tenant_id=c.tenant_id and l.session_id=c.session_id and l.seq=c.seq)::int as actual_rows
    from pi_durable_commits c where tenant_id=${missing.tenantId}::uuid and session_id=${missing.sessionId} and seq=2`.execute(
      database,
    )
  ).rows[0];

  const tampered = await pgFixture();
  await tampered.store.commit(
    [
      { type: "conversation", value: { id: 1 } },
      {
        type: "entry",
        value: { id: 2, conversationId: 1, kind: "review", data: { text: "original" } },
      },
    ],
    context,
  );
  await tampered.store.close(context);
  const changed = {
    type: "entry",
    value: { id: 2, conversationId: 1, kind: "review", data: { text: "changed-without-commit" } },
  };
  await sql`update pi_durable_log set body=${JSON.stringify(changed)} where tenant_id=${tampered.tenantId}::uuid and session_id=${tampered.sessionId} and record_id=2`.execute(
    database,
  );
  try {
    await tampered.projection.rebuild();
    report.rebuild.changedBodyRejected = false;
  } catch (error) {
    report.rebuild.changedBodyRejected = true;
    report.rebuild.changedBodyError = error.message;
  }
  report.rebuild.changedRead = (await tampered.projection.get(2))?.value.data.text;
} catch (error) {
  report.failure = { name: error.name, message: error.message };
  throw error;
} finally {
  await database?.destroy();
  await postgres?.close();
  await rm(directory, { recursive: true, force: true });
  await mkdir(resolve(output, ".."), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      output,
      synthetic: report.synthetic,
      nativeStreaming: report.nativeStreaming,
      rebuild: report.rebuild,
      coldDocument: report.coldDocument,
      failure: report.failure,
    }),
  );
}
