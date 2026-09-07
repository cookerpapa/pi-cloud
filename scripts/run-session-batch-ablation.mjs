import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { randomUUID, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createDatabase, runMigrations } from "@pi-cloud/database";
import { PostgresPiSessionStorage } from "@pi-cloud/pi-session-postgres";
import { sql } from "kysely";

const root = process.cwd(),
  baseline = process.env.PI_CLOUD_BATCH_BASELINE ?? "c8472665";
const scratch = await mkdtemp(join(tmpdir(), "pi-cloud-batch-review-"));
const container = `pi-cloud-batch-${randomUUID()}`,
  password = randomBytes(24).toString("hex");
const docker = (args) =>
  execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let db,
  created = false;
try {
  // Historical source is an acceptance fixture only, never a runtime fallback.
  let source = execFileSync(
    "git",
    ["show", `${baseline}:packages/pi-session-postgres/src/postgres-session-storage.ts`],
    { encoding: "utf8" },
  );
  source = source.replaceAll('from "./', `from "${root}/packages/pi-session-postgres/src/`);
  const file = join(scratch, "baseline.mts");
  await writeFile(file, source);
  await symlink(join(root, "node_modules"), join(scratch, "node_modules"));
  const Old = (await import(pathToFileURL(file).href)).PostgresPiSessionStorage;
  docker([
    "run",
    "--rm",
    "-d",
    "--name",
    container,
    "--memory",
    "768m",
    "--cpus",
    "2",
    "-p",
    "127.0.0.1::5432",
    "-e",
    `POSTGRES_PASSWORD=${password}`,
    "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94",
  ]);
  created = true;
  const port = Number(docker(["port", container, "5432/tcp"]).split(":").at(-1));
  db = createDatabase({
    connectionString: `postgresql://postgres:${password}@127.0.0.1:${port}/postgres`,
    maxConnections: 16,
  });
  for (let n = 0; ; n++) {
    try {
      docker(["exec", container, "pg_isready", "-h", "127.0.0.1", "-U", "postgres"]);
      break;
    } catch {
      if (n === 100) throw new Error("PG not ready");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  await runMigrations(db, "up");
  const tenantId = randomUUID();
  await db.insertInto("tenants").values({ id: tenantId, slug: "batch-ablation" }).execute();
  const results = [];
  // ABBA order limits a simple warm-cache advantage. Each arm uses new Sessions.
  for (const [name, Storage] of [
    ["before", Old],
    ["after", PostgresPiSessionStorage],
    ["after", PostgresPiSessionStorage],
    ["before", Old],
  ]) {
    const sessions = Array.from({ length: 128 }, () => randomUUID());
    for (const sessionId of sessions)
      await PostgresPiSessionStorage.create({ database: db, tenantId, sessionId });
    let cursor = 0,
      statements = 0;
    const times = [],
      started = performance.now();
    const measured = db.withPlugin({
      transformQuery({ node }) {
        statements++;
        return node;
      },
      async transformResult({ result }) {
        return result;
      },
    });
    await Promise.all(
      Array.from({ length: 16 }, async () => {
        while (cursor < sessions.length) {
          const sessionId = sessions[cursor++];
          for (let round = 0; round < 4; round++) {
            const storage = new Storage({
              database: measured,
              tenantId,
              sessionId,
              projectedMutationId: randomUUID(),
            });
            const start = performance.now();
            await storage.appendItems([
              {
                kind: "append_entry",
                lane: "main",
                entry: {
                  id: randomUUID(),
                  type: "custom",
                  customType: "batch.benchmark",
                  data: { text: "x".repeat(1024) },
                },
              },
              {
                kind: "append_record",
                record: {
                  id: randomUUID(),
                  lane: "main",
                  type: "step_attempt",
                  runId: "benchmark-operation",
                  step: "assistant",
                  attempt: round + 1,
                  resultEntryId: "benchmark-entry",
                },
              },
            ]);
            times.push(performance.now() - start);
          }
        }
      }),
    );
    const elapsedMs = performance.now() - started;
    times.sort((a, b) => a - b);
    for (const sessionId of sessions) {
      const rows = await new PostgresPiSessionStorage({
        database: db,
        tenantId,
        sessionId,
      }).getLog();
      if (rows.length !== 8 || rows.some((row, i) => row.seq !== i + 1))
        throw new Error("Batch replay differs from expected ordered log");
    }
    results.push({
      name,
      batches: times.length,
      statementsPerBatch: statements / times.length,
      batchesPerSecond: (times.length * 1000) / elapsedMs,
      latencyMs: {
        p50: times[Math.floor(times.length * 0.5)],
        p95: times[Math.floor(times.length * 0.95)],
      },
    });
  }
  const sharedSession = randomUUID(),
    sharedId = randomUUID();
  const shared = await PostgresPiSessionStorage.create({
    database: db,
    tenantId,
    sessionId: sharedSession,
  });
  await shared.createLane("child", null);
  let release, locked;
  const ready = new Promise((resolve) => (locked = resolve));
  const holding = db.transaction().execute(async (tx) => {
    await tx
      .selectFrom("pi_sessions")
      .select("id")
      .where("id", "=", sharedSession)
      .forUpdate()
      .execute();
    locked();
    await new Promise((resolve) => (release = resolve));
  });
  await ready;
  let reservations = 0;
  const observed = db.withPlugin({
    transformQuery({ node, queryId }) {
      if (db.getExecutor().compileQuery(node, queryId).sql.includes("update pi_sessions"))
        reservations++;
      return node;
    },
    async transformResult({ result }) {
      return result;
    },
  });
  const writer = () =>
    new PostgresPiSessionStorage({
      database: observed,
      tenantId,
      sessionId: sharedSession,
      projectedMutationId: randomUUID(),
    });
  const racing = Promise.allSettled([
    writer().appendItems([
      {
        kind: "append_entry",
        lane: "main",
        entry: { id: sharedId, type: "custom", customType: "race", data: null },
      },
    ]),
    writer().appendItems([
      {
        kind: "append_record",
        record: {
          id: sharedId,
          lane: "child",
          type: "operation_finished",
          runId: "race-op",
          outcome: "completed",
        },
      },
    ]),
  ]);
  try {
    const deadline = Date.now() + 5000;
    while (reservations < 2) {
      if (Date.now() > deadline) throw new Error("Both Lane writers did not reach the lock");
      await new Promise((r) => setTimeout(r, 5));
    }
  } finally {
    release();
    await holding;
  }
  const raceResults = await racing;
  if (raceResults.filter((r) => r.status === "fulfilled").length !== 1)
    throw new Error("Concurrent Lanes reused an Entry/Record id");
  const namespace =
    await sql`select id from pi_session_entries where session_id=${sharedSession} and id=${sharedId}
    union all select id from pi_session_records where session_id=${sharedSession} and id=${sharedId}`.execute(
      db,
    );
  if (namespace.rows.length !== 1) throw new Error("Shared ID namespace diverged");
  const report = {
    format: "pi-cloud.session-batch-ablation.v1",
    checkedAt: new Date().toISOString(),
    baseline,
    concurrentLaneIdNamespace: true,
    scope:
      "two-item atomic native append, 128 Sessions x4 per arm, concurrency16, isolated PostgreSQL 2CPU/768MiB; no model/Cube; excludes outer projection receipts",
    results,
  };
  await writeFile(
    "docs/reports/session-batch-ablation-latest.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
} finally {
  await db?.destroy();
  if (created) docker(["rm", "-f", container]);
  await rm(scratch, { recursive: true, force: true });
}
