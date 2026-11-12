import { writeRuntimeFileAtomically } from "./lib/runtime-file-policy.mjs";
import { metadataRelease } from "./lib/metadata-release.mjs";
import { retireWorkspaceRegistrations } from "./lib/retire-workspace-registrations.mjs";
import { prepareReleasePlan } from "./lib/release-plan.mjs";
import { nativeComputeRetirement } from "./lib/native-compute-retirement.mjs";
import { assertBoxLiteEmpty } from "./lib/boxlite-maintenance.mjs";
import { nativeCubeLifecycleOptions } from "./lib/cube-native-lifecycle-options.mjs";
import { reconcileCubeEgressGateway } from "./lib/cube-egress-release.mjs";
import { ensureMeteringSecret } from "./lib/metering-secret.mjs";
import { configureBuildProxy } from "./lib/upstream-proxy.mjs";
import { updateProviderRuntimePolicyFile } from "./lib/provider-runtime-policy.mjs";
import { serializeRelease } from "./lib/release-lock.mjs";
import {
  deploymentFromEvidence,
  digest,
  assertServingComponents,
  assertMatchedServingComponents,
} from "./lib/component-release.mjs";
import { parseModelCatalogConfiguration } from "../packages/protocol/src/model-catalog.ts";
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, rm, statfs, access } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { guestBuildIdentity } from "./lib/guest-build-identity.mjs";
import { verifyMatchedRelease, matchedMachineDrained } from "./lib/matched-release.mjs";
import { assertCubeKvmAvailable } from "./lib/cube-host-preflight.mjs";
import {
  repositoryRoot as root,
  runtimeDirectory,
  runtimeEnvironment,
  kubectl,
  workload,
  serviceAddress,
  kubeconfig,
  namespace,
} from "./lib/production-kubernetes.mjs";
import { createDatabase, runMigrations } from "../packages/database/src/index.ts";
import { OfficialCubeSandboxRuntimeClient } from "../packages/sandbox-control/src/cubesandbox-runtime-client.ts";
import { CubePersistentCapsuleCodec } from "../packages/sandbox-control/src/cube-persistent-capsule.ts";
import { createComputeRetirementRepository } from "./lib/compute-retirement-postgres.mjs";
import {
  assertRetirementProcessesStopped,
  awaitComputeRetirementQuiescence,
  retireComputeForMaintenance,
} from "./lib/compute-retirement.mjs";
import {
  rootCommand,
  nativeStorageMaintenancePending,
  resumeColdMatchedStorage,
  stopNativeStorageConsumers,
  prepareMatchedWorkspaceStorage,
} from "./lib/matched-workspace-storage.mjs";
import { sql } from "kysely";
import {
  prepareCubeUpgradePlan,
  finalizeCubeUpgradePlan,
  verifyCubeUpgradePlan,
} from "./lib/cube-upgrade-plan.mjs";

configureBuildProxy();

const [action, path, version, option] = process.argv.slice(2);
assert(option === undefined, "Unknown matched publication option");
if (action === "--help") {
  console.log(
    "Usage: node --import tsx scripts/run-matched-release.mjs prepare DIRECTORY VERSION | preflight DIRECTORY | apply DIRECTORY\nPrepare builds/scans locally without changing the serving catalog. Apply drains settled Runs/writers, then deploys matched artifacts. Compute is retired with confirmed absence; stable machine intent and Workspace files are preserved. See docs/MATCHED_RELEASE.md.",
  );
  process.exit(0);
}
assert(
  ["prepare", "preflight", "apply"].includes(action) && path,
  "Invalid matched-release command",
);
serializeRelease(runtimeDirectory);
const directory = resolve(path);
const capture = (command, args, options = {}) =>
  execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  }).trim();
const run = (script, args = [], env = process.env) =>
  execFileSync(process.execPath, [script, ...args], { cwd: root, stdio: "inherit", env });
const environment = (tag, nativeVersion = tag) => ({
  ...process.env,
  PI_CLOUD_IMAGE_VERSION: tag,
  PI_CLOUD_BUILD_TAG: tag,
  PI_CLOUD_CUBE_IMAGE_VERSION: nativeVersion,
  PI_CLOUD_IMAGE_CATALOG: resolve(directory, "images.json"),
  PI_CLOUD_CUBE_RELEASE_DIRECTORY: directory,
});
const phase = (name) => console.log(JSON.stringify({ phase: name }));
const cubeOptions = (tag) => ({
  repositoryRoot: root,
  runtimeDirectory,
  directory,
  tag,
  kubeconfig,
  cubeRepository: resolve(
    process.env.PI_CLOUD_CUBESANDBOX_REPOSITORY ?? resolve(root, "../CubeSandbox"),
  ),
});
const upstreamArgs = [
  "--manifest",
  resolve(directory, "cube-chart.rendered.yaml"),
  "--evidence",
  resolve(directory, "cube-upstream-images.json"),
];
const componentOperator = (args) =>
  execFileSync(
    process.execPath,
    ["--import", "tsx", "scripts/run-component-release.mjs", ...args],
    { cwd: root, stdio: "inherit", env: process.env },
  );
if (action !== "prepare") {
  const prepared = JSON.parse(await readFile(resolve(directory, "candidate.json"), "utf8"));
  if (prepared.scope) {
    componentOperator([action, directory]);
    process.exit(0);
  }
  if (prepared.mode === "metadata") {
    console.log(
      JSON.stringify(
        await metadataRelease({
          action,
          directory,
          root,
          capture,
          kubectl,
          kubeconfig,
          namespace,
          deploymentPath: resolve(runtimeDirectory, "k3s/deployment.json"),
        }),
      ),
    );
    process.exit(0);
  }
  if (prepared.mode === "none") {
    const plan = JSON.parse(await readFile(resolve(directory, "release-plan.json"), "utf8"));
    const baseline = JSON.parse(
      await readFile(resolve(runtimeDirectory, "k3s/deployment.json"), "utf8"),
    );
    assert.equal(digest(plan), prepared.releasePlanDigest);
    assert.equal(digest(baseline), plan.baselineDigest);
    assert.equal(capture("git", ["rev-parse", "HEAD"]), plan.revision);
    assert.equal(capture("git", ["status", "--porcelain", "--untracked-files=all"]), "");
    console.log(JSON.stringify({ mode: "none", servingChanges: false }));
    process.exit(0);
  }
}
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
  const baseline = JSON.parse(
    await readFile(resolve(runtimeDirectory, "k3s/deployment.json"), "utf8"),
  );
  const plan = await prepareReleasePlan({
    root,
    baseline,
    images: serving,
    revision: capture("git", ["rev-parse", "HEAD"]),
    version,
  });
  console.log(
    JSON.stringify({
      releasePlan: {
        mode: plan.mode,
        scope: plan.scope,
        roles: plan.roles,
        drainRoles: plan.drainRoles,
        build: plan.artifacts.filter((a) => a.action !== "reuse").map((a) => a.name),
        reuse: plan.artifacts.filter((a) => a.action === "reuse").map((a) => a.name),
        maintenance: plan.maintenance,
      },
    }),
  );
  if (plan.mode === "metadata") {
    console.log(
      JSON.stringify(
        await metadataRelease({
          action,
          directory,
          root,
          plan,
          baseline,
          capture,
          kubectl,
          kubeconfig,
          namespace,
          deploymentPath: resolve(runtimeDirectory, "k3s/deployment.json"),
        }),
      ),
    );
    process.exit(0);
  }
  if (plan.mode === "none") {
    await mkdir(directory, { mode: 0o700 });
    await writeFile(resolve(directory, "release-plan.json"), JSON.stringify(plan, null, 2) + "\n", {
      mode: 0o600,
    });
    await writeFile(
      resolve(directory, "candidate.json"),
      JSON.stringify({ formatVersion: 2, mode: "none", releasePlanDigest: digest(plan) }) + "\n",
      { mode: 0o600 },
    );
    console.log(JSON.stringify({ mode: "none", servingChanges: false }));
    process.exit(0);
  }
  if (plan.mode === "component") {
    componentOperator(["prepare", plan.scope, directory, version]);
    await writeFile(resolve(directory, "release-plan.json"), JSON.stringify(plan, null, 2) + "\n", {
      mode: 0o600,
    });
    process.exit(0);
  }
  const disk = await statfs(root);
  assert(disk.bavail / disk.blocks >= 0.15, "Reclaim build cache before preparing the release");
  await mkdir(directory, { mode: 0o700 });
  const env = environment(version, plan.nativeVersion);
  await writeFile(resolve(directory, "release-plan.json"), JSON.stringify(plan, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await writeFile(resolve(directory, "images.json"), JSON.stringify(plan.images, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await writeFile(resolve(directory, "baseline.json"), JSON.stringify(baseline, null, 2) + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  await ensureMeteringSecret(runtimeDirectory);
  phase("render complete pinned Cube chart against preserved installed overrides");
  await prepareCubeUpgradePlan(cubeOptions(plan.nativeVersion));
  phase("capture immutable upstream Cube dependency images");
  run("scripts/prefetch-cubesandbox-images.mjs", [...upstreamArgs, "--prepare-only"], env);
  const cubeReleasePlanDigest = await finalizeCubeUpgradePlan(cubeOptions(plan.nativeVersion));
  phase("check declared Docker build inputs");
  run("scripts/check-docker-build-context.mjs");
  if (plan.artifacts.some((a) => a.name === "cubesandbox-tool" && a.action === "build")) {
    phase("build changed guest (no registration)");
    run("scripts/build-cube-tool-image.mjs", [], env);
  }
  if (plan.artifacts.some((a) => a.action === "pull")) {
    phase("prepare changed pinned native images");
    run("scripts/build-cubesandbox-runtime.mjs", [], env);
  }
  for (const artifact of plan.artifacts.filter((a) => a.action === "build" && a.dockerfile)) {
    phase(`build ${artifact.name}`);
    if (artifact.key) run("scripts/production-kubernetes.mjs", ["build", artifact.key], env);
    else
      execFileSync(
        "docker",
        [
          "build",
          "--file",
          artifact.dockerfile,
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
          `PI_CLOUD_REVISION=${plan.revision}`,
          "--tag",
          artifact.reference,
          ".",
        ],
        { cwd: root, stdio: "inherit", env },
      );
  }
  phase("scan matched artifacts");
  run(
    "scripts/generate-release-evidence.mjs",
    [
      "--image-version",
      version,
      "--output-dir",
      resolve(directory, "evidence"),
      "--plan",
      resolve(directory, "release-plan.json"),
    ],
    env,
  );
  await writeFile(
    resolve(directory, "candidate.json"),
    JSON.stringify(
      {
        formatVersion: 2,
        version,
        nativeVersion: plan.nativeVersion,
        releasePlanDigest: digest(plan),
        baselineDigest: plan.baselineDigest,
        revision: capture("git", ["rev-parse", "HEAD"]),
        guestIdentity: await guestBuildIdentity(root),
        cubeReleasePlanDigest,
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
assert.match(
  candidate.cubeReleasePlanDigest ?? "",
  /^[0-9a-f]{64}$/,
  "Prepare the complete native chart/image release plan",
);
const recordedDeployment = JSON.parse(
  await readFile(resolve(runtimeDirectory, "k3s/deployment.json"), "utf8"),
);
if (
  recordedDeployment.releasePlanDigest === candidate.releasePlanDigest &&
  recordedDeployment.version === candidate.version
) {
  assertServingComponents(
    recordedDeployment,
    JSON.parse(kubectl(["get", "deployments,statefulsets,daemonsets", "-o", "json"])).items,
  );
  phase("recorded candidate is already applied; no runtime mutation");
  process.exit(0);
}
assert.equal(
  digest(recordedDeployment),
  candidate.baselineDigest,
  "Another publication changed the matched baseline",
);
let applyReceipt;
try {
  applyReceipt = JSON.parse(await readFile(resolve(directory, "apply-started.json"), "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const liveWorkloads = JSON.parse(
  kubectl(["get", "deployments,statefulsets,daemonsets", "-o", "json"]),
).items;
if (applyReceipt) {
  assert.equal(
    applyReceipt.releasePlanDigest,
    candidate.releasePlanDigest,
    "Another candidate owns partial publication",
  );
  assert.equal(applyReceipt.baselineDigest, candidate.baselineDigest);
  assertMatchedServingComponents(recordedDeployment, candidate.plan, liveWorkloads);
} else assertServingComponents(recordedDeployment, liveWorkloads);
const storageWasStopped = await nativeStorageMaintenancePending(directory);
const physicalMaintenance = candidate.plan.maintenance.physical;
assert(
  !storageWasStopped || physicalMaintenance,
  "An interrupted physical handoff requires its original maintenance plan",
);
if (action !== "apply") {
  assert(
    !storageWasStopped,
    "Resume the recorded cold storage operation with apply before native preflight",
  );
  await verifyCubeUpgradePlan({
    ...cubeOptions(candidate.nativeVersion),
    expectedDigest: candidate.cubeReleasePlanDigest,
  });
  phase("matched artifact and full native chart preflight passed");
  process.exit(0);
}
if (storageWasStopped) {
  // Cube Pods are deliberately absent during a resumed storage handoff. Check
  // the local maintained host now and recheck the restored Cube Pod below.
  await access("/dev/kvm", constants.R_OK | constants.W_OK);
  phase("cold storage resume: host KVM available");
} else {
  assertCubeKvmAvailable({ kubectl });
  phase("Cube KVM device preflight passed");
}
await resumeColdMatchedStorage({ directory, runtimeDirectory, root, kubectl });
await verifyCubeUpgradePlan({
  ...cubeOptions(candidate.nativeVersion),
  expectedDigest: candidate.cubeReleasePlanDigest,
});
phase("matched artifact and full native chart preflight passed before writer/VM drain");
const env = environment(candidate.version, candidate.nativeVersion);
rootCommand(
  process.execPath,
  [resolve(root, "scripts/prefetch-cubesandbox-images.mjs"), ...upstreamArgs],
  root,
);
// Import content before touching live workloads. Existing tags/catalog stay intact.
const cachedImages = new Set(
  capture("/usr/local/bin/k3s", ["ctr", "images", "ls", "-q"]).split("\n"),
);
const canonicalImage = (reference) =>
  /[.:]/.test(reference.split("/")[0]) || reference.startsWith("localhost/")
    ? reference
    : `docker.io/${reference}`;
const needsImport = (artifact) =>
  artifact.action !== "reuse" || !cachedImages.has(canonicalImage(artifact.reference));
run(
  "scripts/production-kubernetes.mjs",
  [
    "import-images",
    "--only",
    ...candidate.plan.artifacts.filter((a) => a.key && needsImport(a)).map((a) => a.reference),
  ],
  env,
);
const nativeImports = candidate.plan.artifacts.filter(
  (a) =>
    [
      "cube-api",
      "cube-master",
      "cube-templatecenter",
      "cubelet",
      "cube-api-authorizer",
      "cube-egress-gateway",
    ].includes(a.name) && needsImport(a),
);
if (nativeImports.length) {
  const archive = resolve(directory, "native-images.tar");
  try {
    execFileSync(
      "docker",
      ["save", "--output", archive, ...nativeImports.map((a) => a.reference)],
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
  "session-runtime",
  "session-api",
  "tool-completion",
  "tool-host",
  "control-plane",
  "workspace-volume-gateway",
  "metering",
  "workspace-quota",
];
const original = new Map();
let cutover = false;
async function stop(service) {
  const observed = kubectl([
    "get",
    workload(service),
    "-o",
    "json",
    ...([
      "session-runtime",
      "session-api",
      "tool-completion",
      "tool-host",
      "metering",
      "workspace-quota",
    ].includes(service)
      ? ["--ignore-not-found"]
      : []),
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
async function assertDrained(includeWriters, includeCompute = true) {
  const { rows } = await sql`select
    (select count(*) from runs where state not in ('completed','failed','cancelled','timed_out') or recovery_requested_at is not null or (output_seal_id is not null and output_sealed_at is null))::int as runs,
    (select count(*) from workspace_runtimes where state<>'released')::int as vms,
    (select count(*) from workspace_terminal_sessions where state<>'released')::int as terminals,
    (select count(*) from session_leases where released_at is null)::int as writers,
    (select count(*) from sandbox_tool_bindings)::int as bindings,
    (select count(*) from workspace_file_transfers where state='uploading')::int as workspace_uploads,
    (select count(*) from session_uploads where state='uploading')::int as retained_uploads`.execute(
    database,
  );
  const { writers, bindings, ...rest } = rows[0];
  // Keep failed machine/Workspace records without confusing them with a live
  // compute lifetime. Native inventory below still independently proves absence.
  const machines = await database
    .selectFrom("development_environments")
    .select([
      "state",
      "allocation_closed",
      "allocation_absent",
      "runtime_capsule",
      "runtime_id",
      "runtime_name",
      "agent_activation_id",
      "terminal_active",
    ])
    .where("state", "!=", "released")
    .execute();
  assert(
    Object.entries(rest).every(([key, n]) => n === 0 || (!includeCompute && key === "vms")) &&
      (!includeCompute || machines.every(matchedMachineDrained)) &&
      (!includeWriters || (writers === 0 && bindings === 0)),
    "Drain Runs/seals, Tool bindings and native VM/terminal/machine lifetimes before matched replacement",
  );
}
try {
  await assertDrained(false, false);
  const cluster = JSON.parse(
    await readFile(resolve(runtimeDirectory, "cubesandbox/cluster.json"), "utf8"),
  );
  const directEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(all|https?|no)_proxy$/i.test(key)),
  );
  const assertNativeInventory = (requireAbsent) => {
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
        (!requireAbsent || /SANDBOX_COUNT\s+0\b/.test(inventory)),
      "Native inventory must cover every node and prove compute absence before storage handoff",
    );
  };
  if (physicalMaintenance && !storageWasStopped) assertNativeInventory(false);
  if (!applyReceipt)
    await writeRuntimeFileAtomically(
      resolve(directory, "apply-started.json"),
      JSON.stringify({
        releasePlanDigest: candidate.releasePlanDigest,
        baselineDigest: candidate.baselineDigest,
      }) + "\n",
    );
  phase("drain application writers");
  for (const service of services.slice(0, 3)) await stop(service);
  const deadline = performance.now() + 120_000;
  for (;;) {
    try {
      await assertDrained(true, false);
      break;
    } catch (error) {
      if (performance.now() > deadline) throw error;
      await delay(500);
    }
  }
  for (const service of services.slice(3)) await stop(service);
  // Close admission before physical retirement. Existing intent/Workspace
  // identities stay in PG; no normal VM shutdown is mistaken for user Release.
  await assertDrained(true, false);
  await ensureMeteringSecret(runtimeDirectory);
  if (physicalMaintenance) {
    const repository = createComputeRetirementRepository(database);
    const assertProcessesStopped = async () =>
      assertRetirementProcessesStopped({
        workloads: JSON.parse(kubectl(["get", "deployments,statefulsets", "-o", "json"])).items,
        pods: JSON.parse(kubectl(["get", "pods", "-o", "json"])).items,
      });
    await awaitComputeRetirementQuiescence({ repository, assertProcessesStopped });
    if (!storageWasStopped) {
      const codec = new CubePersistentCapsuleCodec(
        Buffer.from(
          (
            await readFile(resolve(runtimeDirectory, "secrets/cube-persistent-state-key"), "utf8")
          ).trim(),
          "base64url",
        ),
      );
      const native = new OfficialCubeSandboxRuntimeClient({
        ...nativeCubeLifecycleOptions(),
        apiUrl: `http://${cluster.api.host}:${cluster.api.port}`,
        apiKey: (
          await readFile(resolve(runtimeDirectory, "secrets/cubesandbox-api-key"), "utf8")
        ).trim(),
        proxyNodeIp: cluster.proxy.host,
        proxyPort: cluster.proxy.port,
        proxyScheme: "http",
        sandboxDomain: cluster.sandboxDomain,
        egressProxyIp: "10.255.255.254",
      });
      const retirement = nativeComputeRetirement({ cube: native, runtimeDirectory, kubectl });
      try {
        phase("retire compute while retaining Workspaces and machine intent");
        await retireComputeForMaintenance({
          repository,
          native: retirement,
          assertProcessesStopped,
          openCapsule: (value) => codec.open(value),
          progress: (value) => console.log(JSON.stringify(value)),
        });
      } finally {
        await retirement.close();
        await native.close();
      }
      assertNativeInventory(true);
      await assertBoxLiteEmpty({ kubectl });
    } else
      assert.equal(
        (await repository.listTargets()).length,
        0,
        "Interrupted storage handoff lacks complete retirement evidence",
      );
    await assertDrained(true);
    // A filesystem/protocol handoff cannot automatically restore an old stack.
    cutover = true;
    await runMigrations(database, "up");
    phase("preserve and verify Workspace storage with kernel capacity enforcement");
    const restoreNative = await stopNativeStorageConsumers({ directory, kubectl });
    await prepareMatchedWorkspaceStorage({
      database,
      directory,
      runtimeDirectory,
      root,
      domainId: runtimeEnvironment().PI_CLOUD_SANDBOX_DOMAIN_ID ?? "sandbox-domain-0001",
      image: JSON.parse(await readFile(resolve(directory, "images.json"), "utf8")).volumeGateway,
    });
    await restoreNative();
    assertCubeKvmAvailable({ kubectl });
  }
  await assertDrained(true, physicalMaintenance);
  if (!physicalMaintenance && candidate.plan.maintenance.schemaChanged) {
    cutover = true;
    await runMigrations(database, "up");
  }
  phase(
    physicalMaintenance
      ? "matched native and application cutover"
      : "application cutover preserving native compute and storage",
  );
  // Existing installations do not rerun init-production. Reconcile the same
  // deployment-owned provider policy before the matched provider Pod starts.
  await ensureMeteringSecret(runtimeDirectory);
  await updateProviderRuntimePolicyFile(resolve(runtimeDirectory, "secrets/cli-proxy-config.yaml"));
  cutover = true;
  {
    kubectl([
      "set",
      "image",
      "deployment/pi-cloud-cube-api-authorizer",
      `authorizer=${candidate.plan.artifacts.find((a) => a.name === "cube-api-authorizer").reference}`,
    ]);
    kubectl(["rollout", "status", "deployment/pi-cloud-cube-api-authorizer", "--timeout=120s"], {
      timeout: 125000,
    });
    if (physicalMaintenance) {
      run("scripts/reconcile-cubesandbox-release.mjs", [], env);
      run("scripts/configure-tool-completion.mjs", [], env);
      kubectl(["apply", "-f", "deploy/cubesandbox/template-registry.yaml"]);
      phase("wait for native Cube node registration after Pod rollout");
      await waitForCubeNodeReadiness({ kubectl });
      if (candidate.plan.maintenance.storage) {
        const native = new OfficialCubeSandboxRuntimeClient({
          ...nativeCubeLifecycleOptions(),
          apiUrl: `http://${cluster.api.host}:${cluster.api.port}`,
          apiKey: (
            await readFile(resolve(runtimeDirectory, "secrets/cubesandbox-api-key"), "utf8")
          ).trim(),
          proxyNodeIp: cluster.proxy.host,
          proxyPort: cluster.proxy.port,
          proxyScheme: "http",
          sandboxDomain: cluster.sandboxDomain,
          egressProxyIp: "10.255.255.254",
        });
        try {
          const receipt = await retireWorkspaceRegistrations({
            database,
            native,
            root,
            kubectl,
            domainId: runtimeEnvironment().PI_CLOUD_SANDBOX_DOMAIN_ID ?? "sandbox-domain-0001",
            assertQuiescent: async () => {
              await assertDrained(true);
              assertNativeInventory(true);
              await assertBoxLiteEmpty({ kubectl });
            },
          });
          await writeFile(
            resolve(directory, "workspace-registration-retirement.json"),
            JSON.stringify(receipt) + "\n",
            { mode: 0o600 },
          );
        } finally {
          await native.close();
        }
      }
      run(
        "scripts/register-cubesandbox-tool-template.mjs",
        ["--prepared-image-id", candidate.guestImageId],
        env,
      );
    }
  }
  const { deployPlatform } = await import("./production-kubernetes.mjs");
  await deployPlatform({
    images: JSON.parse(await readFile(resolve(directory, "images.json"), "utf8")),
    deploymentEnvironment: { ...runtimeEnvironment(), ...env },
  });
  // The gateway needs the restarted Control Plane's configuration before it can
  // become Ready, so reconcile it after application readiness, before recording
  // successful matched publication. Its image was built/imported/scanned above.
  reconcileCubeEgressGateway(
    kubectl,
    candidate.plan.artifacts.find((a) => a.name === "cube-egress-gateway").reference,
  );
  const installed = resolve(runtimeDirectory, "k3s/images.json");
  await writeRuntimeFileAtomically(installed, await readFile(resolve(directory, "images.json")));
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
  const deployment = deploymentFromEvidence({
    evidence: JSON.parse(await readFile(resolve(directory, "evidence/manifest.json"), "utf8")),
    evidenceDirectory: resolve(directory, "evidence"),
    revision: candidate.revision,
    version: candidate.version,
    catalog: JSON.parse(await readFile(resolve(directory, "images.json"), "utf8")),
    catalogRevision: digest(modelConfig),
    contracts: {
      schema: schema.rows[0].name,
      guestIdentity: candidate.guestIdentity,
      modelRuntimeSnapshot: 1,
      sessionRuntimeReplacement: 1,
      sessionApiReplacement: 1,
      guestHttpCompletion: 1,
      guestExecution: 1,
      sessionActivity: 1,
      toolHostReplacement: 1,
      toolCatalogPublication: 1,
    },
  });
  deployment.nativeDependencies = JSON.parse(
    await readFile(resolve(directory, "cube-upstream-images.json"), "utf8"),
  );
  deployment.operatorRevision = candidate.operatorRevision;
  deployment.releasePlanDigest = candidate.releasePlanDigest;
  run("scripts/configure-provider-websockets.mjs");
  const deploymentPath = resolve(runtimeDirectory, "k3s/deployment.json");
  await writeRuntimeFileAtomically(deploymentPath, JSON.stringify(deployment, null, 2) + "\n");
  await writeFile(
    resolve(directory, "applied.json"),
    JSON.stringify({
      releasePlanDigest: candidate.releasePlanDigest,
      deploymentDigest: digest(deployment),
    }) + "\n",
    { mode: 0o600 },
  );
  phase("deployed; run maintained acceptance before user traffic");
} catch (error) {
  // Pre-cutover failures restore exactly the observed replica counts. A partial
  // protocol cutover stays offline for repair, never automatic mixed rollback.
  const failures = [];
  if (cutover) {
    // A first matched rollout can create roles absent from the old inventory.
    // Stop those too; never leave the new API/Workers running after a partial cutover.
    for (const service of services) {
      try {
        const existing = kubectl(["get", workload(service), "-o", "name", "--ignore-not-found"]);
        if (existing.trim()) await stop(service);
      } catch (failure) {
        failures.push(failure);
      }
    }
  } else {
    for (const [service, replicas] of original) {
      try {
        kubectl(["scale", workload(service), `--replicas=${replicas}`]);
      } catch (failure) {
        failures.push(failure);
      }
    }
  }
  if (failures.length)
    throw new AggregateError(
      [error, ...failures],
      "Matched publication failed; some workload shutdowns remain unconfirmed",
    );
  throw error;
} finally {
  await database.destroy();
}
import { waitForCubeNodeReadiness } from "./lib/cube-node-readiness.mjs";
