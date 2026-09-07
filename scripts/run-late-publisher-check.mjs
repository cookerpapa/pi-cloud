import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { promisify } from "node:util";

if (process.env.PI_CLOUD_LIVE_LATE_PUBLISHER_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_LATE_PUBLISHER_CHECK=1 to allow an isolated PostgreSQL/Kafka process-failure probe",
  );

const exec = promisify(execFile);
const postgres = `pi-cloud-late-pg-${randomUUID()}`;
const runner = `pi-cloud-late-runner-${randomUUID()}`;
const password = randomBytes(24).toString("base64url");
const image = "postgres@sha256:ef257d85f76e48da1c64832459b59fcaba1a4dac97bf5d7450c77753542eee94";
const root = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const docker = async (args) =>
  (await exec("docker", args, { timeout: 180000, maxBuffer: 2 * 1024 * 1024 })).stdout;
let started = false;
try {
  await docker([
    "run",
    "--detach",
    "--rm",
    "--name",
    postgres,
    "--network",
    "pi-cloud-production_event-log",
    "--memory",
    "512m",
    "--cpus",
    "1",
    "--env",
    `POSTGRES_PASSWORD=${password}`,
    "--env",
    "POSTGRES_DB=late_publisher_probe",
    image,
  ]);
  started = true;
  for (let i = 0; ; i++) {
    try {
      await docker([
        "exec",
        postgres,
        "pg_isready",
        "-U",
        "postgres",
        "-d",
        "late_publisher_probe",
      ]);
      break;
    } catch {
      if (i === 100) throw new Error("Isolated PostgreSQL did not start");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  const result = await exec(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      runner,
      "--network",
      "pi-cloud-production_event-log",
      "--memory",
      "768m",
      "--cpus",
      "2",
      "--volume",
      `${root}:/app:ro`,
      "--workdir",
      "/app",
      "--env",
      "PROBE_DATABASE_URL",
      "node:24.18.0-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d",
      "node",
      "--import",
      "tsx",
      "scripts/late-publisher-probe.mjs",
    ],
    {
      env: {
        ...process.env,
        PROBE_DATABASE_URL: `postgresql://postgres:${password}@${postgres}:5432/late_publisher_probe`,
      },
      timeout: 120000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  const report = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.equal(report.format, "pi-cloud.late-publisher-probe.v1");
  report.revision = (await exec("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
  report.isolation =
    "temporary PostgreSQL, unique Kafka topic/group, production services not stopped";
  await writeFile(
    new URL("../docs/reports/late-publisher-probe-latest.json", import.meta.url),
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
  if (report.counterexample) process.exitCode = 1;
} finally {
  // Exact experiment-owned container names; --rm removes their anonymous data volumes.
  await docker(["rm", "--force", runner]).catch(() => {});
  if (started) await docker(["rm", "--force", postgres]);
}
