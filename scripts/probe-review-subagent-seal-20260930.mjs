// Isolated SQL fixture for one production status method; not a live Agent execution.
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
const root = fileURLToPath(new URL("../", import.meta.url));
const { createDatabase } = await import(root + "/packages/database/src/index.ts");
const { sql } = await import(root + "/node_modules/kysely/dist/index.js");
const { PostgresSubagentJobProvider } = await import(
  root + "/packages/subagent-control/src/postgres-subagent-job-provider.ts"
);
if (!process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL)
  throw Error("Provide an isolated PostgreSQL administrator URL");
const url = new URL(process.env.PI_CLOUD_POSTGRES_INTEGRATION_URL),
  admin = createDatabase({ connectionString: url.toString(), maxConnections: 1 });
const name = "review_seal_" + crypto.randomUUID().replaceAll("-", "");
await sql`create database ${sql.id(name)}`.execute(admin);
url.pathname = "/" + name;
const db = createDatabase({ connectionString: url.toString(), maxConnections: 1 });
const report = {
  method:
    "minimal isolated PG rows exercising production status() SQL; reachable states also traced in RunExecutor",
  cases: [],
};
try {
  await sql`create table runs(id uuid primary key,tenant_id uuid,state text,lease_id uuid,output_sealed_at timestamptz,failure_code text,failure_message text);create table subagent_executions(id uuid primary key,tenant_id uuid,child_session_id uuid,child_run_id uuid,sandbox_mode text,state text,failure_code text,failure_message text,settled_at timestamptz,updated_at timestamptz)`.execute(
    db,
  );
  const tenant = crypto.randomUUID();
  const jobs = new PostgresSubagentJobProvider({
    database: db,
    nativeLanes: { childAnchor: () => null, createChildLane: async () => {} },
  });
  for (const state of ["completed", "failed", "cancelled", "timed_out"]) {
    const run = crypto.randomUUID(),
      id = crypto.randomUUID();
    await db
      .insertInto("runs")
      .values({
        id: run,
        tenant_id: tenant,
        state,
        lease_id: crypto.randomUUID(),
        output_sealed_at: null,
        failure_code: state === "timed_out" ? "pi_timeout" : null,
        failure_message: null,
      })
      .execute();
    await db
      .insertInto("subagent_executions")
      .values({
        id,
        tenant_id: tenant,
        child_session_id: crypto.randomUUID(),
        child_run_id: run,
        sandbox_mode: "shared",
        state: "running",
      })
      .execute();
    const status = await jobs.status(tenant, id);
    report.cases.push({ runState: state, sealed: false, reportedState: status.state });
  }
} finally {
  await db.destroy();
  await sql`drop database ${sql.id(name)}`.execute(admin);
  await admin.destroy();
  await writeFile(
    process.argv[2] ?? "/tmp/pi-cloud-review-subagent-seal.json",
    JSON.stringify(report, null, 2) + "\n",
  );
}
console.log(JSON.stringify(report));
