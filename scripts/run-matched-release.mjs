import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, rename, rm, statfs } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { guestBuildIdentity, completionBuildIdentity } from "./lib/guest-build-identity.mjs";
import { verifyMatchedRelease } from "./lib/matched-release.mjs";
import { assertCubeKvmAvailable } from "./lib/cube-host-preflight.mjs";
import {
  repositoryRoot as root,
  runtimeDirectory,
  kubectl,
  workload,
  serviceAddress,
} from "./lib/production-kubernetes.mjs";
import { createDatabase } from "../packages/database/src/index.ts";
import { sql } from "kysely";

const [action, path, version] = process.argv.slice(2);
if (action === "--help") {
  console.log(
    "Usage: node --import tsx scripts/run-matched-release.mjs prepare DIRECTORY VERSION | preflight DIRECTORY | apply DIRECTORY\nPrepare builds/scans locally without changing the serving catalog. Apply requires settled Runs and no native VMs, drains writers, then deploys matched app/Cube/guest artifacts. No data reset. See docs/MATCHED_RELEASE.md.",
  );
  process.exit(0);
}
assert(
  ["prepare", "preflight", "apply"].includes(action) && path,
  "Invalid matched-release command",
);
const directory = resolve(path);
const capture = (command, args) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
  }).trim();
const run = (script, args = [], env = process.env) =>
  execFileSync(process.execPath, [script, ...args], { cwd: root, stdio: "inherit", env });
const environment = (tag) => ({
  ...process.env,
  PI_CLOUD_IMAGE_VERSION: tag,
  PI_CLOUD_BUILD_TAG: tag,
  PI_CLOUD_CUBE_IMAGE_VERSION: tag,
  PI_CLOUD_IMAGE_CATALOG: resolve(directory, "images.json"),
});
const phase = (name) => console.log(JSON.stringify({ phase: name }));
if (action === "prepare") {
  assert(
    /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(version ?? ""),
    "Provide a tag-safe release version",
  );
  assert.equal(
    capture("git", ["status", "--porcelain", "--untracked-files=all"]),
    "",
    "Commit changes before preparing a release",
  );
  const serving = JSON.parse(await readFile(resolve(runtimeDirectory, "k3s/images.json"), "utf8"));
  assert(
    !Object.values(serving).some((reference) => reference.endsWith(`:${version}`)),
    "Use a new tag; serving image tags cannot be rebuilt in place",
  );
  const disk = await statfs(root);
  assert(disk.bavail / disk.blocks >= 0.15, "Reclaim build cache before preparing the release");
  await mkdir(directory, { mode: 0o700 });
  const env = environment(version);
  phase("build guest (no registration)");
  run("scripts/build-cube-tool-image.mjs", [], env);
  phase("build native Cube");
  run("scripts/build-cubesandbox-runtime.mjs", [], env);
  phase("build application candidate");
  run("scripts/production-kubernetes.mjs", ["build"], env);
  phase("scan matched artifacts");
  run(
    "scripts/generate-release-evidence.mjs",
    ["--image-version", version, "--output-dir", resolve(directory, "evidence")],
    env,
  );
  await writeFile(
    resolve(directory, "candidate.json"),
    JSON.stringify(
      {
        formatVersion: 1,
        version,
        revision: capture("git", ["rev-parse", "HEAD"]),
        guestIdentity: await guestBuildIdentity(root),
        completionIdentity: await completionBuildIdentity(root),
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600, flag: "wx" },
  );
}
const currentGuestTemplate = JSON.parse(
  await readFile(resolve(runtimeDirectory, "cubesandbox/template.json"), "utf8"),
);
const candidate = await verifyMatchedRelease({ directory, root, capture, currentGuestTemplate });
phase("matched artifact preflight passed");
if (action !== "apply") process.exit(0);

assertCubeKvmAvailable({ kubectl });
phase("Cube KVM device preflight passed");
const env = environment(candidate.version);
// Import content before touching live workloads. Existing tags/catalog stay intact.
run("scripts/production-kubernetes.mjs", ["import-images"], env);
const archive = resolve(directory, "native-images.tar");
try {
  execFileSync(
    "docker",
    [
      "save",
      "--output",
      archive,
      ...["cube-api", "cube-master", "cubelet"].map(
        (name) => `pi-cloud/${name}:${candidate.version}`,
      ),
    ],
    { stdio: "inherit" },
  );
  execFileSync(
    "k3s",
    ["ctr", "images", "import", "--label", "io.cri-containerd.pinned=pinned", archive],
    { stdio: "inherit" },
  );
} finally {
  await rm(archive, { force: true });
}

const endpoint = new URL(
  (await readFile(resolve(runtimeDirectory, "secrets/database-url"), "utf8")).trim(),
);
endpoint.hostname = serviceAddress("postgres");
const database = createDatabase({ connectionString: endpoint.toString(), maxConnections: 2 });
const services = ["web", "ssh-gateway", "pi-workers", "control-plane", "workspace-volume-gateway"];
const original = new Map();
let cutover = false;
async function stop(service) {
  const object = JSON.parse(kubectl(["get", workload(service), "-o", "json"]));
  original.set(service, object.spec.replicas);
  kubectl(["scale", workload(service), "--replicas=0"]);
  const selector = Object.entries(object.spec.selector.matchLabels)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  if (JSON.parse(kubectl(["get", "pods", "-l", selector, "-o", "json"])).items.length)
    kubectl(["wait", "--for=delete", "pod", "-l", selector, "--timeout=120s"], {
      timeout: 125_000,
    });
}
async function assertDrained(includeWriters) {
  const { rows } = await sql`select
    (select count(*) from runs where state not in ('completed','failed','cancelled','timed_out') or recovery_requested_at is not null or (output_seal_id is not null and output_sealed_at is null))::int as runs,
    (select count(*) from workspace_runtimes where state<>'released')::int as vms,
    (select count(*) from development_environments where state<>'released')::int as machines,
    (select count(*) from workspace_terminal_sessions where state<>'released')::int as terminals,
    (select count(*) from session_leases where released_at is null)::int as writers,
    (select count(*) from sandbox_tool_bindings)::int as bindings`.execute(database);
  const { writers, bindings, ...rest } = rows[0];
  assert(
    Object.values(rest).every((n) => n === 0) &&
      (!includeWriters || (writers === 0 && bindings === 0)),
    "Drain Runs/seals, Tool bindings and native VM/terminal/machine lifetimes before matched replacement",
  );
}
try {
  await assertDrained(false);
  const cluster = JSON.parse(
    await readFile(resolve(runtimeDirectory, "cubesandbox/cluster.json"), "utf8"),
  );
  const directEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(all|https?|no)_proxy$/i.test(key)),
  );
  const inventory = execFileSync(
    resolve(runtimeDirectory, "cubesandbox/cubemastercli"),
    [
      "--address",
      cluster.master.host,
      "--port",
      String(cluster.master.port),
      "list",
      "--all",
      "--wide",
    ],
    { env: directEnv, encoding: "utf8", timeout: 30_000 },
  );
  const scanned = /NODES_SCANNED\s+(\d+)\/(\d+)/.exec(inventory);
  assert(
    scanned &&
      Number(scanned[1]) > 0 &&
      scanned[1] === scanned[2] &&
      /SANDBOX_COUNT\s+0\b/.test(inventory),
    "Native inventory must confirm no VM on every node before replacement",
  );
  phase("drain application writers");
  for (const service of services.slice(0, 3)) await stop(service);
  const deadline = performance.now() + 120_000;
  for (;;) {
    try {
      await assertDrained(true);
      break;
    } catch (error) {
      if (performance.now() > deadline) throw error;
      await delay(500);
    }
  }
  for (const service of services.slice(3)) await stop(service);
  // Close the admission race after all writers have actually exited.
  await assertDrained(true);
  phase("matched Cube, template and application cutover");
  cutover = true;
  run("scripts/configure-cube-completion.mjs", [], env);
  run(
    "scripts/register-cubesandbox-tool-template.mjs",
    ["--prepared-image-id", candidate.guestImageId],
    env,
  );
  run("scripts/production-kubernetes.mjs", ["deploy"], env);
  const installed = resolve(runtimeDirectory, "k3s/images.json");
  await writeFile(installed + ".candidate", await readFile(resolve(directory, "images.json")), {
    mode: 0o600,
  });
  await rename(installed + ".candidate", installed);
  phase("deployed; run maintained acceptance before user traffic");
} catch (error) {
  // Pre-cutover failures restore exactly the observed replica counts. A partial
  // protocol cutover stays offline for repair, never automatic mixed rollback.
  for (const [service, replicas] of original)
    kubectl(["scale", workload(service), `--replicas=${cutover ? 0 : replicas}`]);
  throw error;
} finally {
  await database.destroy();
}
