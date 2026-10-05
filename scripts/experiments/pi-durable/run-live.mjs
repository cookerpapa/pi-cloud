import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawn } from "node:child_process";
import { testPostgres } from "../../lib/test-postgres.mjs";
import { serviceAddress } from "../../lib/production-kubernetes.mjs";
if (process.env.PI_CLOUD_DURABLE_LIVE_CUBE !== "1")
  throw Error("Set PI_CLOUD_DURABLE_LIVE_CUBE=1 for the owned live fixture");
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const output =
  process.argv[2] ?? join(repo, "docs/reports/pi-durable-cube-verification-20261005.json");
const image = execFileSync(
  "docker",
  [
    "image",
    "inspect",
    process.env.PI_CLOUD_DURABLE_PROBE_IMAGE ?? "pi-cloud/control-plane:review-outcomes-v7-app",
    "--format",
    "{{.Id}}",
  ],
  { encoding: "utf8" },
).trim();
assert(/^sha256:[0-9a-f]{64}$/.test(image));
const dir = await mkdtemp(join(tmpdir(), "pi-durable-live-"));
const pg = await testPostgres();
try {
  const args = [
    "run",
    "--rm",
    "--network",
    "host",
    "--user",
    `${process.getuid()}:${process.getgid()}`,
    "--mount",
    `type=bind,src=${repo},dst=${repo},readonly`,
    "--mount",
    `type=bind,src=${dir},dst=/probe-evidence`,
    "--workdir",
    join(repo, "scripts/experiments/pi-durable"),
    ...[1, 2, 3].flatMap((i) => ["--add-host", `kafka-${i}:${serviceAddress(`kafka-${i}`)}`]),
    "--env",
    "PI_CLOUD_DURABLE_LIVE_CUBE=1",
    "--env",
    "PI_CLOUD_DURABLE_BROKERS=kafka-1:9092,kafka-2:9092,kafka-3:9092",
    "--env",
    `PI_CLOUD_POSTGRES_INTEGRATION_URL=${pg.url}`,
    "--entrypoint",
    "node",
    image,
    "--import",
    "tsx",
    "live-cube.mjs",
    "/probe-evidence/result.json",
  ];
  const code = await new Promise((resolve, reject) => {
    const p = spawn("docker", args, { stdio: "inherit" });
    p.once("error", reject);
    p.once("exit", resolve);
  });
  const report = JSON.parse(await readFile(join(dir, "result.json"), "utf8"));
  report.probeContainerImage = image;
  await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  process.exitCode = code ?? 1;
} finally {
  await pg.close();
  await rm(dir, { recursive: true });
}
