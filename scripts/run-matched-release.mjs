import { retireCubeExtensionTables } from "./lib/retire-cube-extension-tables.mjs";
import { nativeCubeLifecycleOptions } from "./lib/cube-native-lifecycle-options.mjs";
import { reconcileCubeEgressGateway } from "./lib/cube-egress-release.mjs";
import { ensureMeteringSecret } from "./lib/metering-secret.mjs";
import { configureBuildProxy } from "./lib/upstream-proxy.mjs";
import { updateProviderRuntimePolicyFile } from "./lib/provider-runtime-policy.mjs";
import { serializeRelease } from "./lib/release-lock.mjs";
import { deploymentFromEvidence, digest } from "./lib/component-release.mjs";
import { parseModelCatalogConfiguration } from "../packages/protocol/src/model-catalog.ts";
import assert from "node:assert/strict";
import { constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile, rename, rm, statfs, access } from "node:fs/promises";
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
  await ensureMeteringSecret(runtimeDirectory);
  phase("render complete pinned Cube chart against preserved installed overrides");
  await prepareCubeUpgradePlan(cubeOptions(version));
  phase("capture immutable upstream Cube dependency images");
  run("scripts/prefetch-cubesandbox-images.mjs", [...upstreamArgs, "--prepare-only"], env);
  const cubeReleasePlanDigest = await finalizeCubeUpgradePlan(cubeOptions(version));
  phase("check declared Docker build inputs");
  run("scripts/check-docker-build-context.mjs");
  {
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
const storageWasStopped = await nativeStorageMaintenancePending(directory);
if (action !== "apply") {
  assert(
    !storageWasStopped,
    "Resume the recorded cold storage operation with apply before native preflight",
  );
  await verifyCubeUpgradePlan({
    ...cubeOptions(candidate.version),
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
  ...cubeOptions(candidate.version),
  expectedDigest: candidate.cubeReleasePlanDigest,
});
phase("matched artifact and full native chart preflight passed before writer/VM drain");
const env = environment(candidate.version);
rootCommand(
  process.execPath,
  [resolve(root, "scripts/prefetch-cubesandbox-images.mjs"), ...upstreamArgs],
  root,
);
// Import content before touching live workloads. Existing tags/catalog stay intact.
run("scripts/production-kubernetes.mjs", ["import-images"], env);
{
  const archive = resolve(directory, "native-images.tar");
  try {
    execFileSync(
      "docker",
      [
        "save",
        "--output",
        archive,
        ...[
          "cube-api",
          "cube-master",
          "cube-templatecenter",
          "cubelet",
          "cube-api-authorizer",
          "cube-egress-gateway",
        ].map((name) => `pi-cloud/${name}:${candidate.version}`),
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
  if (!storageWasStopped) assertNativeInventory(false);
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
  {
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
      try {
        phase("retire compute while retaining Workspaces and machine intent");
        await retireComputeForMaintenance({
          repository,
          native,
          assertProcessesStopped,
          openCapsule: (value) => codec.open(value),
          progress: (value) => console.log(JSON.stringify(value)),
        });
      } finally {
        await native.close();
      }
      assertNativeInventory(true);
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
  await assertDrained(true);
  phase("matched Cube, template and application cutover");
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
      `authorizer=pi-cloud/cube-api-authorizer:${candidate.version}`,
    ]);
    kubectl(["rollout", "status", "deployment/pi-cloud-cube-api-authorizer", "--timeout=120s"], {
      timeout: 125000,
    });
    run("scripts/reconcile-cubesandbox-release.mjs", [], env);
    run("scripts/configure-tool-completion.mjs", [], env);
    kubectl(["apply", "-f", "deploy/cubesandbox/template-registry.yaml"]);
    phase("wait for native Cube node registration after Pod rollout");
    await waitForCubeNodeReadiness({ kubectl });
    await retireCubeExtensionTables({
      kubectl,
      tag: candidate.version,
      assertDrained: () => assertDrained(true),
      assertNativeAbsent: () => assertNativeInventory(true),
    });
    run(
      "scripts/register-cubesandbox-tool-template.mjs",
      ["--prepared-image-id", candidate.guestImageId],
      env,
    );
  }
  const { deployPlatform } = await import("./production-kubernetes.mjs");
  await deployPlatform({
    images: JSON.parse(await readFile(resolve(directory, "images.json"), "utf8")),
    deploymentEnvironment: { ...runtimeEnvironment(), ...env },
  });
  // The gateway needs the restarted Control Plane's configuration before it can
  // become Ready, so reconcile it after application readiness, before recording
  // successful matched publication. Its image was built/imported/scanned above.
  reconcileCubeEgressGateway(kubectl, `pi-cloud/cube-egress-gateway:${candidate.version}`);
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
  const deployment = deploymentFromEvidence({
    evidence: JSON.parse(await readFile(resolve(directory, "evidence/manifest.json"), "utf8")),
    evidenceDirectory: resolve(directory, "evidence"),
    revision: candidate.revision,
    version: candidate.version,
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
