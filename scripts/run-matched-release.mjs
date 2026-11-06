import {
  verifyMeteringRetention,
  retainSandboxProvenance,
  retainedSandboxComponents,
} from "./lib/model-metering-release.mjs";
import { readFileSync } from "node:fs";
import { configureBuildProxy } from "./lib/upstream-proxy.mjs";
import { updateProviderRuntimePolicyFile } from "./lib/provider-runtime-policy.mjs";
import { serializeRelease } from "./lib/release-lock.mjs";
import { deploymentFromEvidence, digest } from "./lib/component-release.mjs";
import { parseModelCatalogConfiguration } from "../packages/protocol/src/model-catalog.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, rename, rm, statfs } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { guestBuildIdentity, completionBuildIdentity } from "./lib/guest-build-identity.mjs";
import { verifyMatchedRelease, matchedMachineDrained } from "./lib/matched-release.mjs";
import { assertCubeKvmAvailable } from "./lib/cube-host-preflight.mjs";
import {
  repositoryRoot as root,
  runtimeDirectory,
  runtimeEnvironment,
  kubectl,
  workload,
  serviceAddress,
} from "./lib/production-kubernetes.mjs";
import { createDatabase } from "../packages/database/src/index.ts";
import { sql } from "kysely";

configureBuildProxy();

const [action, path, version, option] = process.argv.slice(2);
assert(
  option === undefined || option === "--retain-sandbox-runtime",
  "Unknown matched publication option",
);
if (action === "--help") {
  console.log(
    "Usage: node --import tsx scripts/run-matched-release.mjs prepare DIRECTORY VERSION [--retain-sandbox-runtime] | preflight DIRECTORY | apply DIRECTORY\nPrepare builds/scans locally without changing the serving catalog. Apply drains settled Runs/writers, then deploys matched artifacts. ADR-0297 can retain verified unchanged Sandbox artifacts and VM allocations. No data reset. See docs/MATCHED_RELEASE.md.",
  );
  process.exit(0);
}
assert(
  ["prepare", "preflight", "apply"].includes(action) && path,
  "Invalid matched-release command",
);
serializeRelease(runtimeDirectory);
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
  phase("check declared Docker build inputs");
  run("scripts/check-docker-build-context.mjs");
  if (option !== "--retain-sandbox-runtime") {
    phase("build guest (no registration)");
    run("scripts/build-cube-tool-image.mjs", [], env);
    phase("build native Cube");
    run("scripts/build-cubesandbox-runtime.mjs", [], env);
    phase("build matched Cube API authorization callback and egress gateway");
    for (const component of ["cube-api-authorizer", "cube-egress-gateway"])
      execFileSync(
        "docker",
        [
          "build",
          "--file",
          `packages/${component}/Dockerfile`,
          "--network=host",
          "--build-arg",
          "HTTP_PROXY",
          "--build-arg",
          "HTTPS_PROXY",
          "--build-arg",
          "NO_PROXY",
          "--build-arg",
          `PI_CLOUD_VERSION=${version}`,
          "--build-arg",
          `PI_CLOUD_REVISION=${capture("git", ["rev-parse", "HEAD"])}`,
          "--tag",
          `pi-cloud/${component}:${version}`,
          ".",
        ],
        { cwd: root, stdio: "inherit", env },
      );
  }
  phase("build application candidate");
  run("scripts/production-kubernetes.mjs", ["build"], env);
  phase("scan matched artifacts");
  run(
    "scripts/generate-release-evidence.mjs",
    [
      "--image-version",
      version,
      "--output-dir",
      resolve(directory, "evidence"),
      ...(option === "--retain-sandbox-runtime" ? ["--component", "host"] : []),
    ],
    env,
  );
  await writeFile(
    resolve(directory, "candidate.json"),
    JSON.stringify(
      {
        formatVersion: 1,
        ...(option === "--retain-sandbox-runtime"
          ? {
              retainedDeploymentDigest: digest(
                JSON.parse(
                  await readFile(resolve(runtimeDirectory, "k3s/deployment.json"), "utf8"),
                ),
              ),
            }
          : {}),
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
const baseline = candidate.retainedDeploymentDigest
  ? JSON.parse(await readFile(resolve(runtimeDirectory, "k3s/deployment.json"), "utf8"))
  : null;
const retainedSandboxRuntime = baseline
  ? verifyMeteringRetention({
      baseline,
      candidate,
      capture,
      root,
      readFile: (path) => readFileSync(path, "utf8"),
      template: currentGuestTemplate,
    })
  : undefined;
if (baseline) {
  const objects = JSON.parse(
    kubectl([
      "get",
      "deployment/cube-api",
      "deployment/cube-master",
      "daemonset/cube-node",
      "deployment/pi-cloud-cube-api-authorizer",
      "deployment/pi-cloud-cube-egress-gateway",
      "-o",
      "json",
    ]),
  );
  const images = new Set(
    objects.items.flatMap((o) => o.spec.template.spec.containers.map((c) => c.image)),
  );
  for (const name of retainedSandboxComponents.filter((n) => n !== "cubesandbox-tool"))
    assert(
      images.has(baseline.components[name].reference),
      `Serving retained component changed: ${name}`,
    );
}
phase("matched artifact preflight passed");
if (action !== "apply") process.exit(0);

assertCubeKvmAvailable({ kubectl });
phase("Cube KVM device preflight passed");
const env = environment(candidate.version);
// Import content before touching live workloads. Existing tags/catalog stay intact.
run("scripts/production-kubernetes.mjs", ["import-images"], env);
if (!retainedSandboxRuntime) {
  const archive = resolve(directory, "native-images.tar");
  try {
    execFileSync(
      "docker",
      [
        "save",
        "--output",
        archive,
        ...["cube-api", "cube-master", "cubelet", "cube-api-authorizer", "cube-egress-gateway"].map(
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
}

const endpoint = new URL(
  (await readFile(resolve(runtimeDirectory, "secrets/database-url"), "utf8")).trim(),
);
endpoint.hostname = serviceAddress("postgres");
const database = createDatabase({ connectionString: endpoint.toString(), maxConnections: 2 });
const services = [
  "web",
  "ssh-gateway",
  "pi-workers",
  "control-plane",
  "workspace-volume-gateway",
  "metering",
];
const original = new Map();
let cutover = false;
async function stop(service) {
  const observed = kubectl([
    "get",
    workload(service),
    "-o",
    "json",
    ...(service === "metering" ? ["--ignore-not-found"] : []),
  ]);
  // A newly introduced stateless Deployment has nothing to drain on first install.
  if (!observed.trim()) return;
  const object = JSON.parse(observed);
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
    (select count(*) from workspace_terminal_sessions where state<>'released')::int as terminals,
    (select count(*) from session_leases where released_at is null)::int as writers,
    (select count(*) from sandbox_tool_bindings)::int as bindings`.execute(database);
  const { writers, bindings, ...rest } = rows[0];
  // Keep failed machine/Workspace records without confusing them with a live
  // compute lifetime. Native inventory below still independently proves absence.
  const machines = await database
    .selectFrom("development_environments")
    .select([
      "state",
      "allocation_closed",
      "runtime_id",
      "runtime_name",
      "agent_activation_id",
      "terminal_active",
    ])
    .where("state", "!=", "released")
    .execute();
  assert(
    Object.entries(rest).every(
      ([key, n]) => n === 0 || (retainedSandboxRuntime && key === "vms"),
    ) &&
      (retainedSandboxRuntime || machines.every(matchedMachineDrained)) &&
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
      (retainedSandboxRuntime || /SANDBOX_COUNT\s+0\b/.test(inventory)),
    "Native inventory must cover every node; replacing Cube additionally requires zero VMs",
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
  // Existing installations do not rerun init-production. Reconcile the same
  // deployment-owned provider policy before the matched provider Pod starts.
  await updateProviderRuntimePolicyFile(resolve(runtimeDirectory, "secrets/cli-proxy-config.yaml"));
  cutover = true;
  if (!retainedSandboxRuntime) {
    kubectl([
      "set",
      "image",
      "deployment/pi-cloud-cube-api-authorizer",
      `authorizer=pi-cloud/cube-api-authorizer:${candidate.version}`,
    ]);
    kubectl(["rollout", "status", "deployment/pi-cloud-cube-api-authorizer", "--timeout=120s"], {
      timeout: 125000,
    });
    run("scripts/configure-cube-completion.mjs", [], env);
    run(
      "scripts/register-cubesandbox-tool-template.mjs",
      ["--prepared-image-id", candidate.guestImageId],
      env,
    );
  }
  const { deployPlatform } = await import("./production-kubernetes.mjs");
  await deployPlatform({
    retainedSandboxRuntime,
    images: JSON.parse(await readFile(resolve(directory, "images.json"), "utf8")),
    deploymentEnvironment: { ...runtimeEnvironment(), ...env },
  });
  // The gateway needs the restarted Control Plane's configuration before it can
  // become Ready, so reconcile it after application readiness, before recording
  // successful matched publication. Its image was built/imported/scanned above.
  if (!retainedSandboxRuntime) {
    kubectl([
      "set",
      "image",
      "deployment/pi-cloud-cube-egress-gateway",
      `gateway=pi-cloud/cube-egress-gateway:${candidate.version}`,
    ]);
    kubectl(["rollout", "status", "deployment/pi-cloud-cube-egress-gateway", "--timeout=120s"], {
      timeout: 125000,
    });
  }
  const installed = resolve(runtimeDirectory, "k3s/images.json");
  await writeFile(installed + ".candidate", await readFile(resolve(directory, "images.json")), {
    mode: 0o600,
  });
  await rename(installed + ".candidate", installed);
  const modelConfig = parseModelCatalogConfiguration(
    JSON.parse(
      JSON.parse(kubectl(["get", "configmap", "pi-cloud-model-catalog", "-o", "json"])).data[
        "model-catalog.json"
      ],
    ),
  );
  const schema = await sql`select name from kysely_migration order by name desc limit 1`.execute(
    database,
  );
  let deployment = deploymentFromEvidence({
    evidence: JSON.parse(await readFile(resolve(directory, "evidence/manifest.json"), "utf8")),
    evidenceDirectory: resolve(directory, "evidence"),
    revision: candidate.revision,
    version: candidate.version,
    catalogRevision: digest(modelConfig),
    contracts: {
      schema: schema.rows[0].name,
      guestIdentity: candidate.guestIdentity,
      completionIdentity: candidate.completionIdentity,
      modelRuntimeSnapshot: 1,
      controlPlaneReplacement: 1,
    },
  });
  if (baseline) deployment = retainSandboxProvenance(deployment, baseline);
  const deploymentPath = resolve(runtimeDirectory, "k3s/deployment.json");
  await writeFile(deploymentPath + ".next", JSON.stringify(deployment, null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(deploymentPath + ".next", deploymentPath);
  run("scripts/configure-provider-websockets.mjs");
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
