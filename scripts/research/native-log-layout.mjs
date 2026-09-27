// Isolated D5 storage study. No deployment URL is accepted, no model is called.
// Run: node --import tsx scripts/research/native-log-layout.mjs /tmp/layout.json
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import { sql } from "kysely";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { PostgresPiSessionStorage } from "@pi-cloud/pi-session-postgres";
import { InMemorySessionStorage } from "@earendil-works/pi-agent-core";

const root = fileURLToPath(new URL("../..", import.meta.url));
const image = "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94";
const sizes = (process.env.PI_CLOUD_LAYOUT_SIZES ?? "2000,20000").split(",").map(Number);
const repetitions = Number(process.env.PI_CLOUD_LAYOUT_REPETITIONS ?? 25);
assert(sizes.length >= 1 && sizes.length <= 3);
assert(sizes.every((n) => Number.isSafeInteger(n) && n >= 100 && n <= 50_000));
assert(Number.isSafeInteger(repetitions) && repetitions >= 3 && repetitions <= 100);
assert.equal(new Set(sizes).size, sizes.length);
const output = process.argv[2] ?? "/tmp/pi-cloud-native-log-layout.json";
const schemas = ["full_copy", "indexed_log", "thin_index"];
const tenant = "11111111-1111-4111-8111-111111111111";
const secondTenant = "22222222-2222-4222-8222-222222222222";
const container = `pi-cloud-layout-study-${randomUUID()}`;
const password = randomBytes(24).toString("base64url");
const pools = [];
let admin;
let started = false;
const report = {
  recordedAt: new Date().toISOString(),
  revision: command("git", ["rev-parse", "HEAD"]),
  image,
  sizes,
  repetitions,
  methodology: {
    cpus: 2,
    memory: "3g",
    pgdata: "tmpfs 2g",
    sharedBuffers: "256MB",
    durability:
      "fsync/full_page_writes/synchronous_commit on; tmpfs is NOT a physical disk durability benchmark",
    layout:
      "Migrated schema clones retain CHECK/UNIQUE/indexes. LIKE does not copy FKs/triggers. No FK/trigger costs in any layout.",
    writes:
      "identical JSON batches, one transaction and one data-modifying CTE per batch; no Projector, broker, network quorum or control mutations",
    reads:
      "existing PostgresPiSessionStorage + schema-local read views; warm cache, sequential round-robin; latency includes Node/socket/JSON decoding",
    scope:
      "read equivalence and query plans, NOT complete Pi write conformance or production cutover acceptance",
  },
  fixture: [],
  writes: [],
  storage: [],
  reads: [],
  plans: [],
  checks: [],
};

function command(executable, args) {
  const result = spawnSync(executable, args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0)
    throw new Error(`${executable} failed: ${(result.stderr || result.stdout).slice(0, 2000)}`);
  return result.stdout.trim();
}
function progress(message) {
  console.error(message);
}
function percentile(values, fraction) {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)].toFixed(3));
}
function turnId(i) {
  return `33333333-3333-4333-8333-${Math.ceil(i / 20)
    .toString()
    .padStart(12, "0")}`;
}
function body(i) {
  const length = i % 31 === 0 ? 32_768 : i % 5 === 0 ? 8192 : 768;
  const lines = [];
  for (let offset = 0, written = 0; written < length; offset++) {
    const hash = createHash("sha256").update(`layout/${i}/${offset}`).digest("hex");
    const line = `export const sample_${i}_${offset} = "${hash}"; // synthetic fixture\n`;
    lines.push(line);
    written += line.length;
  }
  return lines.join("").slice(0, length);
}
const usage = {
  input: 100,
  output: 20,
  cacheRead: 30,
  cacheWrite: 10,
  totalTokens: 160,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

async function fixture(count, sessionId, tenantId = tenant) {
  const memory = new InMemorySessionStorage({ id: sessionId, createdAt: 1 });
  const entryLanes = new Map();
  const bindings = new Map();
  let parent = null;
  await memory.createLane("child", null);
  for (let i = 1; i <= count; i++) {
    const binding = turnId(i);
    const start = await memory.appendRecord({
      id: `op${i}`,
      lane: "main",
      type: "operation_started",
      sourceLeafId: parent,
      intent: { kind: "run", originalPrompt: [], initialMessages: [] },
    });
    bindings.set(start.id, binding);
    const text = body(i);
    const data =
      i === count - 64
        ? { type: "compaction", summary: `Summary ${i}`, retainedTail: [], tokensBefore: 10000 }
        : i % 16 === 0
          ? { type: "custom", customType: "study.state", data: { text } }
          : {
              type: "message",
              message:
                i % 2 === 0
                  ? {
                      role: "assistant",
                      content: [{ type: "text", text }],
                      api: "openai-responses",
                      provider: "fixture",
                      model: "fixture",
                      usage,
                      stopReason: "stop",
                      timestamp: 1,
                    }
                  : { role: "user", content: [{ type: "text", text }], timestamp: 1 },
            };
    const entry = await memory.appendEntry({ id: `e${i}`, ...data }, "main");
    parent = entry.id;
    entryLanes.set(entry.id, "main");
    bindings.set(entry.id, binding);
    if (i % 4 === 0) {
      const record = await memory.appendRecord({
        id: `usage${i}`,
        type: "usage",
        lane: "main",
        runId: start.id,
        entryId: entry.id,
        cause: "assistant",
        attempt: 1,
        stopReason: "stop",
        usage,
      });
      bindings.set(record.id, binding);
    }
    if (i % 10 === 0) {
      const child = await memory.appendEntry(
        { id: `child${i}`, type: "custom", customType: "study.child", data: { i } },
        "child",
      );
      entryLanes.set(child.id, "child");
      bindings.set(child.id, binding);
    }
    // One suspended operation at the end; recovery's limit=2 must still check older starts.
    if (i !== count) {
      const record = await memory.appendRecord({
        id: `done${i}`,
        type: "operation_finished",
        lane: "main",
        runId: start.id,
        outcome: "completed",
      });
      bindings.set(record.id, binding);
    }
  }
  await memory.setName("Layout fixture");
  await memory.setLabel(parent, "leaf");
  const log = await memory.getLog();
  const rows = log.map((item, index) => ({
    tenant_id: tenantId,
    session_id: sessionId,
    seq: item.seq,
    kind: item.kind,
    payload:
      item.kind === "entry"
        ? {
            entry: item.entry,
            lane: entryLanes.get(item.entry.id),
            turnId: bindings.get(item.entry.id),
          }
        : item.kind === "record"
          ? { record: item.record, turnId: bindings.get(item.record.id) }
          : Object.fromEntries(
              Object.entries(item).filter(([key]) => key !== "kind" && key !== "seq"),
            ),
    append_id:
      (index + 1) % 100 === 0 || index === log.length - 1
        ? `44444444-4444-4444-8444-${item.seq.toString().padStart(12, "0")}`
        : null,
  }));
  return { count, sessionId, tenantId, memory, rows, leaf: parent };
}

const cloneTables = [
  "pi_sessions",
  "pi_session_lanes",
  "pi_session_labels",
  "pi_session_log",
  "pi_session_entry_refs",
];
async function createLayout(schema) {
  await admin.query(`create schema ${schema}; set search_path = ${schema}, public`);
  for (const table of cloneTables)
    await admin.query(`create table ${table} (like public.${table} including all)`);
  if (schema === "indexed_log") {
    const ddl = await readFile(new URL("native-log-layout.sql", import.meta.url), "utf8");
    await admin.query(ddl.replaceAll("{{schema}}", schema));
  } else {
    for (const table of ["pi_session_entries", "pi_session_records"]) {
      const target = schema === "thin_index" ? `${table}_index` : table;
      await admin.query(`create table ${target} (like public.${table} including all)`);
      if (schema === "thin_index") {
        await admin.query(`alter table ${target} drop column payload`);
        const kind = table === "pi_session_entries" ? "entry" : "record";
        // A scalar lookup is evaluated only when payload is actually selected.
        await admin.query(`create view ${table} as select item.*,
          (select log.payload -> '${kind}' from pi_session_log log
           where log.tenant_id = item.tenant_id and log.session_id = item.session_id and log.seq = item.seq) as payload
          from ${target} item`);
      }
    }
  }
  const ownEntries = `select tenant_id, session_id, id, seq, parent_id, type, custom_type, timestamp_ms, payload,
           session_id as source_session_id, id as source_entry_id, false as inherited
    from pi_session_entries`;
  // Each Fork already has its complete log. Keeping the old COW UNION around
  // the computed payload prevents ordered LIMIT pushdown in this prototype.
  // The empty refs table remains ONLY for the existing branch reader's SQL.
  if (schema === "indexed_log") {
    await admin.query(`create view pi_session_visible_entries as ${ownEntries}`);
    return;
  }
  await admin.query(`create view pi_session_visible_entries as
    ${ownEntries}
    union all
    select ref.tenant_id, ref.session_id, ref.id, ref.seq, ref.parent_id, ref.type, ref.custom_type,
           ref.timestamp_ms, source.payload, ref.source_session_id, ref.source_entry_id, true as inherited
    from pi_session_entry_refs ref join pi_session_entries source
      on source.tenant_id = ref.tenant_id and source.session_id = ref.source_session_id and source.id = ref.source_entry_id`);
}

function insertSQL(schema) {
  let sql = `with incoming as materialized (
    select * from jsonb_to_recordset($1::jsonb) as r(tenant_id uuid,session_id text,seq bigint,kind text,payload jsonb,append_id uuid)
  ), logged as (
    insert into ${schema}.pi_session_log(tenant_id,session_id,seq,kind,payload,append_id)
    select tenant_id,session_id,seq,kind,payload,append_id from incoming returning seq
  )`;
  if (schema !== "indexed_log") {
    const suffix = schema === "thin_index" ? "_index" : "";
    const payloadColumn = schema === "thin_index" ? "" : ",payload";
    const entryPayload = schema === "thin_index" ? "" : ",payload->'entry'";
    const recordPayload = schema === "thin_index" ? "" : ",payload->'record'";
    sql += `, entries as (insert into ${schema}.pi_session_entries${suffix}
      (tenant_id,session_id,id,seq,parent_id,type,custom_type,timestamp_ms,turn_id${payloadColumn})
      select tenant_id,session_id,payload#>>'{entry,id}',seq,payload#>>'{entry,parentId}',
        payload#>>'{entry,type}',payload#>>'{entry,customType}',(payload#>>'{entry,timestamp}')::bigint,
        (payload->>'turnId')::uuid${entryPayload} from incoming where kind='entry' returning seq),
      records as (insert into ${schema}.pi_session_records${suffix}
      (tenant_id,session_id,id,seq,lane,type,run_id,operation_kind,timestamp_ms,turn_id${payloadColumn})
      select tenant_id,session_id,payload#>>'{record,id}',seq,payload#>>'{record,lane}',payload#>>'{record,type}',
        case when payload#>>'{record,type}'='operation_started' then payload#>>'{record,id}' else payload#>>'{record,runId}' end,
        payload#>>'{record,intent,kind}',(payload#>>'{record,timestamp}')::bigint,
        (payload->>'turnId')::uuid${recordPayload} from incoming where kind='record' returning seq)`;
  }
  return `${sql} select count(*)::int as inserted from logged`;
}

async function insertFixture(schema, data) {
  await admin.query(`set search_path = ${schema}, public`);
  await admin.query(
    "insert into pi_sessions(tenant_id,id,created_at_ms,next_seq,name) values($1,$2,1,$3,$4)",
    [data.tenantId, data.sessionId, data.rows.length + 1, await data.memory.getName()],
  );
  for (const lane of await data.memory.getLanes())
    await admin.query(
      "insert into pi_session_lanes(tenant_id,session_id,lane,leaf_id) values($1,$2,$3,$4)",
      [data.tenantId, data.sessionId, lane.lane, lane.leafId],
    );
  await admin.query(
    "insert into pi_session_labels(tenant_id,session_id,target_id,label,updated_seq) values($1,$2,$3,'leaf',$4)",
    [data.tenantId, data.sessionId, data.leaf, data.rows.length],
  );
  const before = (await admin.query("select pg_current_wal_insert_lsn()::text as lsn")).rows[0].lsn;
  const times = [];
  for (let offset = 0; offset < data.rows.length; offset += 100) {
    const json = JSON.stringify(data.rows.slice(offset, offset + 100));
    const begin = performance.now();
    await admin.query("begin");
    await admin.query(insertSQL(schema), [json]);
    await admin.query("commit");
    times.push(performance.now() - begin);
  }
  const wal = (
    await admin.query("select pg_wal_lsn_diff(pg_current_wal_insert_lsn(),$1)::text as bytes", [
      before,
    ])
  ).rows[0].bytes;
  report.writes.push({
    schema,
    sessionId: data.sessionId,
    rows: data.rows.length,
    batches: times.length,
    walBytes: Number(wal),
    totalMs: Number(times.reduce((a, b) => a + b, 0).toFixed(3)),
    batchP50Ms: percentile(times, 0.5),
    batchP95Ms: percentile(times, 0.95),
  });
}

function measuredDatabase(url, schema) {
  const scoped = new URL(url);
  scoped.searchParams.set("options", `-c search_path=${schema},public -c statement_timeout=30000`);
  const base = createDatabase({ connectionString: scoped.toString(), maxConnections: 1 });
  pools.push(base);
  const captured = [];
  const db = base.withPlugin({
    transformQuery({ node, queryId }) {
      captured.push(base.getExecutor().compileQuery(node, queryId));
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  return { schema, db, captured };
}
function readCases(data) {
  const turns = Array.from({ length: Math.min(40, Math.ceil(data.count / 20)) }, (_, i) =>
    turnId(data.count - i * 20),
  );
  const selectedTurns = new Set(turns);
  const turnEntries = data.rows.filter(
    (row) => row.kind === "entry" && selectedTurns.has(row.payload.turnId),
  );
  return [
    ["point", (s) => s.getEntry(data.leaf)],
    ["page_messages", (s) => s.findEntries({ type: "message", limit: 40, order: "newestFirst" })],
    ["page_custom", (s) => s.findEntries({ type: "custom", customType: "study.state", limit: 20 })],
    [
      "branch_compaction",
      (s) =>
        s.findEntriesOnBranch({ start: data.leaf, stopAtType: "compaction", order: "newestFirst" }),
    ],
    [
      "branch_page",
      (s) => s.findEntriesOnBranch({ start: data.leaf, limit: 20, order: "newestFirst" }),
    ],
    ["records_page", (s) => s.findRecords({ lane: "main", type: "usage", limit: 40 })],
    [
      "records_run",
      (s) =>
        s.findRecords({ lane: "main", type: "operation_finished", runId: `op${data.count - 1}` }),
    ],
    ["open_operations", (s) => s.findOpenOperations("main", { limit: 2 })],
    ["stats", (s) => s.getStats()],
    ["log_page", (s) => s.getLog({ afterSeq: Math.max(0, data.rows.length - 64), limit: 40 })],
    [
      "latest_assistant",
      async (_s, db) =>
        db
          ? (
              await db
                .selectFrom("pi_session_entries")
                .select("payload")
                .where("tenant_id", "=", data.tenantId)
                .where("session_id", "=", data.sessionId)
                .where("turn_id", "=", turnId(data.count))
                .where("type", "=", "message")
                .where(sql`payload #>> '{message,role}'`, "=", "assistant")
                .orderBy("seq", "desc")
                .limit(1)
                .execute()
            ).map((r) => r.payload)
          : turnEntries
              .filter(
                (r) =>
                  r.payload.turnId === turnId(data.count) &&
                  r.payload.entry.message?.role === "assistant",
              )
              .slice(-1)
              .map((r) => r.payload.entry),
    ],
    // The product's additional turns/sessions ownership JOIN is audited in the
    // report; this measures the history body lookup after that owner is known.
    [
      "turn_history_40",
      async (_s, db) =>
        db
          ? (
              await db
                .selectFrom("pi_session_entries")
                .select("payload")
                .where("tenant_id", "=", data.tenantId)
                .where("session_id", "=", data.sessionId)
                .where("turn_id", "in", turns)
                .orderBy("seq", "asc")
                .execute()
            ).map((r) => r.payload)
          : turnEntries.map((r) => r.payload.entry),
    ],
  ];
}
function planNodes(node) {
  return [node, ...(node.Plans ?? []).flatMap(planNodes)];
}
function literal(value) {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  assert.equal(typeof value, "string");
  return `'${value.replaceAll("'", "''")}'`;
}
async function explain(schema, name, sessionId, queries) {
  await admin.query(`set search_path = ${schema}, public`);
  for (const mode of ["force_custom_plan", "force_generic_plan"]) {
    await admin.query(`set plan_cache_mode = ${mode}`);
    for (const [index, query] of queries.entries()) {
      await admin.query(`prepare study_plan as ${query.sql}`);
      try {
        const args = query.parameters.length ? `(${query.parameters.map(literal).join(",")})` : "";
        const result = (
          await admin.query(
            `explain (analyze,buffers,timing off,format json) execute study_plan${args}`,
          )
        ).rows[0]["QUERY PLAN"][0];
        const nodes = planNodes(result.Plan);
        const scans = nodes
          .filter((n) => n["Relation Name"])
          .map((n) => ({
            type: n["Node Type"],
            relation: n["Relation Name"],
            index: n["Index Name"],
            rows: n["Actual Rows"],
            loops: n["Actual Loops"],
            indexCond: n["Index Cond"],
            removed: n["Rows Removed by Filter"] ?? 0,
            heapFetches: n["Heap Fetches"],
          }));
        const recursive = nodes
          .filter((n) => n["Node Type"] === "Recursive Union")
          .map((n) => n["Actual Rows"]);
        if (name === "branch_compaction" && index === 0) {
          assert.deepEqual(
            recursive,
            [65],
            `${schema}/${mode}: compaction traversal must stay bounded`,
          );
          const repeated = scans.filter(
            (n) => n.loops > 10 && n.relation !== "pi_session_entry_refs",
          );
          if (Number(sessionId.slice(1)) >= 2000) {
            assert(
              repeated.every((n) => /Index/.test(n.type) && n.removed === 0),
              `${schema}/${mode}: per-parent indexed lookups ${JSON.stringify(repeated)}`,
            );
          }
        }
        report.plans.push({
          schema,
          sessionId,
          name,
          index,
          mode,
          executionMs: result["Execution Time"],
          sharedHitBlocks: result.Plan["Shared Hit Blocks"],
          sharedReadBlocks: result.Plan["Shared Read Blocks"],
          recursiveRows: recursive,
          scans,
        });
      } finally {
        await admin.query("deallocate study_plan");
      }
    }
  }
  await admin.query("set plan_cache_mode = auto");
}

async function measureReads(data, handles) {
  for (const [name, read] of readCases(data)) {
    const expected = await read(data.memory);
    const times = Object.fromEntries(schemas.map((schema) => [schema, []]));
    for (const handle of handles) {
      handle.storage = new PostgresPiSessionStorage({
        database: handle.db,
        tenantId: data.tenantId,
        sessionId: data.sessionId,
      });
      handle.captured.length = 0;
      assert.deepEqual(
        await read(handle.storage, handle.db),
        expected,
        `${handle.schema}/${data.sessionId}/${name}`,
      );
      const queries = [...handle.captured];
      await explain(handle.schema, name, data.sessionId, queries);
      // Warm named plans, including PostgreSQL's custom/generic decision.
      for (let n = 0; n < 6; n++) await read(handle.storage, handle.db);
    }
    for (let n = 0; n < repetitions; n++) {
      for (let offset = 0; offset < handles.length; offset++) {
        const handle = handles[(offset + n) % handles.length];
        handle.captured.length = 0;
        const begin = performance.now();
        await read(handle.storage, handle.db);
        times[handle.schema].push(performance.now() - begin);
      }
    }
    for (const schema of schemas)
      report.reads.push({
        schema,
        sessionId: data.sessionId,
        name,
        p50Ms: percentile(times[schema], 0.5),
        p95Ms: percentile(times[schema], 0.95),
      });
    report.checks.push(`${data.sessionId}/${name}: 3 layouts equal native fixture`);
  }
}

async function additionalChecks(data, handles) {
  const extraCases = [
    ["cursor", (s) => s.findEntries({ order: "oldestFirst", cursor: { afterSeq: 30 }, limit: 12 })],
    [
      "branch_oldest",
      (s) => s.findEntriesOnBranch({ start: "e90", order: "oldestFirst", limit: 7 }),
    ],
    [
      "branch_filtered",
      (s) =>
        s.findEntriesOnBranch({
          start: "e90",
          type: "custom",
          customType: "study.state",
          limit: 3,
        }),
    ],
    ["branch_stop_id", (s) => s.findEntriesOnBranch({ start: "e90", stopAtId: "e60" })],
    ["empty_page", (s) => s.findEntries({ customType: "absent", limit: 3 })],
    ["metadata", (s) => s.getMetadata().then(({ tenantId, ...metadata }) => metadata)],
    ["lanes", (s) => s.getLanes()],
    ["name", (s) => s.getName()],
    ["label", (s) => s.getLabel(data.leaf)],
  ];
  for (const [name, read] of extraCases) {
    const expected = await read(data.memory);
    for (const handle of handles) {
      const storage = new PostgresPiSessionStorage({
        database: handle.db,
        tenantId: data.tenantId,
        sessionId: data.sessionId,
      });
      const actual = await read(storage);
      if (name === "lanes") {
        expected.sort((a, b) => a.lane.localeCompare(b.lane));
        actual.sort((a, b) => a.lane.localeCompare(b.lane));
      }
      assert.deepEqual(actual, expected, `${handle.schema}/${name}`);
    }
    report.checks.push(`${data.sessionId}/${name}: 3 layouts equal Pi InMemorySessionStorage`);
  }
  // Complete copied Fork log, as required by ADR-0147; no COW provenance in this fixture.
  const selected = await data.memory.findEntriesOnBranch({ start: "e90", order: "oldestFirst" });
  const forkRows = selected.map((entry, i) => ({
    tenant_id: tenant,
    session_id: "fork",
    seq: i + 1,
    kind: "entry",
    payload: { lane: "main", turnId: null, entry: { ...entry, seq: i + 1 } },
    append_id: null,
  }));
  for (const handle of handles) {
    await admin.query(`set search_path = ${handle.schema}, public`);
    await admin.query(
      "insert into pi_sessions(tenant_id,id,created_at_ms,next_seq) values($1,'fork',1,91)",
      [tenant],
    );
    await admin.query(insertSQL(handle.schema), [JSON.stringify(forkRows)]);
    const fork = new PostgresPiSessionStorage({
      database: handle.db,
      tenantId: tenant,
      sessionId: "fork",
    });
    assert.deepEqual(
      await fork.findEntriesOnBranch({ start: "e90", order: "oldestFirst" }),
      forkRows.map((row) => row.payload.entry),
    );
    await assert.rejects(
      fork.findEntriesOnBranch({ start: "missing" }),
      (error) => error.code === "not_found",
    );
    // Same append_id and item ID in a different tenant is legal; reads must stay scoped.
    const isolated = new PostgresPiSessionStorage({
      database: handle.db,
      tenantId: secondTenant,
      sessionId: data.sessionId,
    });
    assert.equal(
      (await isolated.getEntry("e1")).message.content[0].text.startsWith("other tenant"),
      true,
    );
    const bad = {
      ...forkRows[0],
      seq: 100,
      append_id: randomUUID(),
      payload: {
        lane: "main",
        turnId: null,
        entry: { ...forkRows[0].payload.entry, id: "bad", seq: 100, parentId: "missing" },
      },
    };
    await admin.query("begin");
    await admin.query(insertSQL(handle.schema), [JSON.stringify([bad])]);
    await admin.query("rollback");
    assert.equal(await fork.getEntry("bad"), undefined);
    await admin.query(insertSQL(handle.schema), [JSON.stringify([bad])]);
    await assert.rejects(
      fork.findEntriesOnBranch({ start: "bad" }),
      (error) => error.code === "invalid_entry",
    );
    await assert.rejects(
      admin.query(insertSQL(handle.schema), [
        JSON.stringify([{ ...bad, seq: 101, append_id: randomUUID() }]),
      ]),
      (error) => error.code === "23505",
    );
    const duplicateAppend = {
      ...bad,
      seq: 102,
      payload: { ...bad.payload, entry: { ...bad.payload.entry, id: "new-id", seq: 102 } },
    };
    await assert.rejects(
      admin.query(insertSQL(handle.schema), [JSON.stringify([duplicateAppend])]),
      (error) => error.code === "23505",
    );
  }
  report.checks.push(
    "3 layouts: copied Fork log reads, missing/corrupt ancestry, tenant isolation, rollback, duplicate append/item rejection",
  );
}

try {
  progress("Starting isolated PostgreSQL 17.6");
  command("docker", [
    "run",
    "--detach",
    "--name",
    container,
    "--cpus",
    "2",
    "--memory",
    "3g",
    "--tmpfs",
    "/var/lib/postgresql/data:rw,size=2g",
    "--publish",
    "127.0.0.1::5432",
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "--env",
    "POSTGRES_DB=layout_study",
    image,
    "-c",
    "shared_buffers=256MB",
    "-c",
    "work_mem=16MB",
  ]);
  started = true;
  const port = Number(/:(\d+)$/.exec(command("docker", ["port", container, "5432/tcp"]))?.[1]);
  const url = `postgresql://postgres:${password}@127.0.0.1:${port}/layout_study`;
  for (let attempt = 0; attempt < 100; attempt++) {
    admin = new Client({ connectionString: url });
    try {
      await admin.connect();
      break;
    } catch {
      await admin.end();
      if (attempt === 99) throw new Error("Temporary PG readiness timed out");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  report.postgres = (
    await admin.query(
      "select version() as version, current_setting('fsync') as fsync, current_setting('synchronous_commit') as synchronous_commit, current_setting('full_page_writes') as full_page_writes",
    )
  ).rows[0];
  const migrationDB = createDatabase({ connectionString: url, maxConnections: 1 });
  try {
    await runMigrations(migrationDB, "up");
  } finally {
    await migrationDB.destroy();
  }
  for (const schema of schemas) await createLayout(schema);
  const handles = schemas.map((schema) => measuredDatabase(url, schema));
  for (const count of sizes) {
    progress(`Generating ${count} main entries using native Pi memory backend`);
    const data = await fixture(count, `s${count}`);
    report.fixture.push({
      sessionId: data.sessionId,
      mainEntries: count,
      logRows: data.rows.length,
      jsonBytes: Buffer.byteLength(JSON.stringify(data.rows)),
      compactedBranchEntries: 65,
    });
    for (const schema of schemas) {
      progress(`Loading ${schema}/${count}`);
      await insertFixture(schema, data);
    }
    // Identical IDs/sequence/append IDs in another tenant, but distinguishable payload.
    const other = { ...data.rows.find((row) => row.kind === "entry"), tenant_id: secondTenant };
    other.payload = structuredClone(other.payload);
    other.payload.entry.message.content[0].text = "other tenant fixture";
    for (const schema of schemas) {
      await admin.query(
        `insert into ${schema}.pi_sessions(tenant_id,id,created_at_ms) values($1,$2,1)`,
        [secondTenant, data.sessionId],
      );
      await admin.query(insertSQL(schema), [JSON.stringify([other])]);
      // Only study schemas are vacuumed; never an external deployment.
      const tables = (
        await admin.query("select tablename from pg_tables where schemaname=$1", [schema])
      ).rows;
      for (const { tablename } of tables)
        await admin.query(`vacuum (analyze) ${schema}."${tablename}"`);
    }
    progress(`Comparing actual SessionStorage reads and custom/generic plans for ${count}`);
    await measureReads(data, handles);
    if (count === sizes[0]) await additionalChecks(data, handles);
  }
  report.storage = (
    await admin.query(
      `select n.nspname as schema, c.relname as relation,
    pg_table_size(c.oid)::float8 as table_bytes, pg_indexes_size(c.oid)::float8 as index_bytes,
    pg_total_relation_size(c.oid)::float8 as total_bytes
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname = any($1::text[]) and c.relkind='r' order by n.nspname,c.relname`,
      [schemas],
    )
  ).rows;
  report.sourceHashes = {};
  for (const file of [
    "scripts/research/native-log-layout.mjs",
    "scripts/research/native-log-layout.sql",
    "packages/pi-session-postgres/src/postgres-session-storage.ts",
  ]) {
    report.sourceHashes[file] = createHash("sha256")
      .update(await readFile(`${root}/${file}`))
      .digest("hex");
  }
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  progress(`Study passed: ${report.checks.length} check groups, evidence written to ${output}`);
} finally {
  for (const pool of pools) await pool.destroy();
  await admin?.end();
  if (started) command("docker", ["rm", "--force", "--volumes", container]);
}
