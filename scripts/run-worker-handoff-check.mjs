import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { format } from "prettier";

if (process.env.PI_CLOUD_LIVE_WORKER_HANDOFF_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_WORKER_HANDOFF_CHECK=1 to allow real DeepSeek calls and isolated process failures",
  );
const exec = promisify(execFile),
  root = fileURLToPath(new URL("..", import.meta.url));
const suffix = randomUUID(),
  pg = `pi-cloud-handoff-pg-${suffix}`,
  runner = `pi-cloud-handoff-${suffix}`;
const password = randomBytes(24).toString("base64url");
const docker = async (args) =>
  (await exec("docker", args, { timeout: 180000, maxBuffer: 2 * 1024 * 1024 })).stdout;
let created = false;
try {
  await docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    pg,
    "--network",
    "pi-cloud-production_event-log",
    "--cpus",
    "1",
    "--memory",
    "512m",
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "--env",
    "POSTGRES_DB=handoff_probe",
    "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94",
  ]);
  created = true;
  for (let n = 0; ; n++) {
    try {
      await docker(["exec", pg, "pg_isready", "-U", "postgres", "-d", "handoff_probe"]);
      break;
    } catch {
      if (n === 100) throw new Error("Probe PostgreSQL did not start");
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  const env = {
    ...process.env,
    HANDOFF_DATABASE_URL: `postgresql://postgres:${password}@${pg}:5432/handoff_probe`,
  };
  await exec(
    "docker",
    [
      "create",
      "--name",
      runner,
      "--network",
      "pi-cloud-production_event-log",
      "--cpus",
      "3",
      "--memory",
      "2g",
      "--add-host",
      "handoff-a:127.0.0.1",
      "--add-host",
      "handoff-b:127.0.0.1",
      "--volume",
      `${root}:/app:ro`,
      "--workdir",
      "/app",
      "--env",
      "HANDOFF_DATABASE_URL",
      "--env",
      "TSX_TSCONFIG_PATH=/app/packages/control-plane/tsconfig.json",
      "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d",
      "node",
      "--import",
      "tsx",
      "scripts/worker-handoff-probe.mjs",
    ],
    { env },
  );
  await docker(["network", "connect", "pi-cloud-production_model-egress", runner]);
  const result = await exec("docker", ["start", "--attach", runner], {
    timeout: 600000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const line = result.stdout
    .trim()
    .split("\n")
    .findLast((value) => value.startsWith('{"format":"pi-cloud.worker-handoff'));
  if (!line)
    throw new Error(
      `Probe produced no report: ${result.stdout.slice(-4000)} ${result.stderr.slice(-1000)}`,
    );
  const report = JSON.parse(line);
  const pgLogs = await exec("docker", ["logs", "--tail", "100", pg], {
    timeout: 10000,
    maxBuffer: 256 * 1024,
  });
  const databaseLog = pgLogs.stdout + pgLogs.stderr;
  report.databaseDeadlocks = (databaseLog.match(/ERROR:.*deadlock detected/g) ?? []).length;
  if (report.databaseDeadlocks)
    report.databaseLockDiagnostics = databaseLog
      .split("\n")
      .filter((line) =>
        /deadlock detected|waits for|blocked by|Process [0-9]+:|STATEMENT:/.test(line),
      )
      .map((line) => line.slice(0, 500))
      .slice(-20);
  report.revision = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  report.workingTreeDirty =
    (await exec("git", ["status", "--porcelain"], { cwd: root })).stdout.trim().length > 0;
  await writeFile(
    new URL("../docs/reports/worker-handoff-probe-latest.json", import.meta.url),
    await format(JSON.stringify(report), { parser: "json" }),
  );
  console.log(JSON.stringify({ ...report, facts: report.facts.length }));
  if (report.failure || report.latePublicationChangedBranch || report.tailFailures?.length)
    process.exitCode = 1;
} finally {
  await docker(["rm", "--force", runner]).catch(() => {});
  if (created) await docker(["rm", "--force", pg]);
}
