import { configureBuildProxy } from "./lib/upstream-proxy.mjs";
import { changedVisibleModels, probeCatalogModel } from "./lib/model-catalog-probe.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { stringify } from "yaml";
import { parseModelCatalogConfiguration } from "../packages/protocol/src/model-catalog.ts";
import {
  repositoryRoot as root,
  runtimeDirectory,
  kubectl,
  kubeconfig,
  namespace,
  serviceAddress,
} from "./lib/production-kubernetes.mjs";
import {
  assertScopedSources,
  assertOperatorRevisionChanges,
  scopedHelmUpgradeArguments,
  assertScopedManifests,
  composeScopedDeployment,
  scopedApplyState,
  manifestDigest,
  digest,
  catalogSeed,
  imageReleaseTargets,
  dockerSourceInputs,
} from "./lib/component-release.mjs";
import {
  replaceControlPlane,
  createReplacementDatabase,
  controlPlaneSnapshot,
  readControlPlaneDomain,
} from "./lib/control-plane-release.mjs";
import { serializeRelease } from "./lib/release-lock.mjs";

configureBuildProxy();

const [action, scopeOrPath, candidatePath, input] = process.argv.slice(2);
if (action === "--help") {
  console.log(
    "prepare provider|web|control-plane DIRECTORY VERSION | prepare catalog DIRECTORY CATALOG_JSON | preflight DIRECTORY | apply DIRECTORY\nScoped releases preserve unrelated workloads. See docs/COMPONENT_RELEASE.md.",
  );
  process.exit(0);
}
assert(["prepare", "preflight", "apply"].includes(action), "Unknown component release action");
serializeRelease(runtimeDirectory);
const directory = resolve(action === "prepare" ? candidatePath : scopeOrPath);
const deploymentPath = resolve(runtimeDirectory, "k3s/deployment.json");
const helm = process.env.PI_CLOUD_HELM_BIN ?? "helm";
const capture = (cmd, args, options = {}) =>
  execFileSync(cmd, args, {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    maxBuffer: 32 * 1024 * 1024,
    ...options,
  }).trim();
const helmCapture = (args) =>
  capture(helm, [...args, "--kubeconfig", kubeconfig, "--namespace", namespace]);
const readJson = (path) => JSON.parse(readFileSync(path, "utf8"));
const save = (path, value) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const run = (script, args = [], env = process.env) =>
  execFileSync(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: root,
    stdio: "inherit",
    env,
  });
const revision = capture("git", ["rev-parse", "HEAD"]);
assert.equal(
  capture("git", ["status", "--porcelain", "--untracked-files=all"]),
  "",
  "Commit source before preparing/applying releases",
);
assert(existsSync(deploymentPath), "Install the matched component-manifest release first");

function installed(name) {
  return {
    values: JSON.parse(helmCapture(["get", "values", name, "--output", "json"])),
    manifest: helmCapture(["get", "manifest", name]),
    status: JSON.parse(helmCapture(["status", name, "--output", "json"])),
  };
}
function render(name, chart, path) {
  return helmCapture(["template", name, chart, "--no-hooks", "--values", path]);
}
function assertServingCombination(deployment, imageAlternative, catalogAlternative) {
  const resources = JSON.parse(
    kubectl(["get", "deployment,statefulset,daemonset", "-o", "json"]),
  ).items;
  const images = new Set(
    resources.flatMap((r) => r.spec.template.spec.containers.map((c) => c.image)),
  );
  for (const [name, component] of Object.entries(deployment.components)) {
    if (name === "cubesandbox-tool") continue;
    assert(
      images.has(component.reference) ||
        (name === imageAlternative?.name && images.has(imageAlternative.reference)),
      `Serving component differs from its record: ${name}`,
    );
  }
  const catalog = parseModelCatalogConfiguration(
    JSON.parse(
      JSON.parse(kubectl(["get", "configmap", "pi-cloud-model-catalog", "-o", "json"])).data[
        "model-catalog.json"
      ],
    ),
  );
  assert(
    [deployment.catalogRevision, catalogAlternative].includes(digest(catalog)),
    "Serving catalog differs from its record",
  );
}
function inputs(scope) {
  if (scope === "control-plane") {
    const file = "packages/control-plane/Dockerfile";
    return dockerSourceInputs(
      file,
      capture("git", ["ls-files"]).split("\n"),
      readFileSync(resolve(root, file), "utf8"),
    );
  }
  if (scope === "web")
    return capture("git", [
      "ls-files",
      "package.json",
      "package-lock.json",
      "tsconfig.base.json",
      "scripts/retry-npm-command.sh",
      "scripts/prepare-json-parser.mjs",
      "packages/protocol/package.json",
      "packages/protocol/src",
      "packages/web-ui",
    ]).split("\n");
  return scope === "provider" ? ["deploy/provider-gateway/Dockerfile"] : [catalogSeed];
}

if (action === "prepare") {
  const scope = scopeOrPath;
  assert(["provider", "catalog", "web", "control-plane"].includes(scope));
  const baseline = readJson(deploymentPath);
  if (scope === "control-plane")
    assert.equal(
      baseline.contracts.controlPlaneReplacement,
      1,
      "Install ADR-0276's matched replacement contract before a Control Plane component release",
    );
  assertServingCombination(baseline);
  const changed = capture("git", ["diff", "--name-only", `${baseline.revision}..${revision}`])
    .split("\n")
    .filter(Boolean);
  assertScopedSources(scope, changed);
  const version =
    scope !== "catalog" ? input : `catalog-${revision.slice(0, 12)}-${Date.now().toString(36)}`;
  assert(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(version ?? ""), "Invalid release version");
  assert(
    !Object.values(baseline.components).some((c) => c.reference.endsWith(`:${version}`)),
    "Use a new immutable image tag",
  );
  const name = scope === "provider" ? "pi-cloud-infrastructure" : "pi-cloud";
  const chart = resolve(
    root,
    "deploy/helm",
    scope === "provider" ? "pi-cloud-infrastructure" : "pi-cloud-platform",
  );
  const live = installed(name);
  assert.equal(
    live.status.info.status,
    "deployed",
    "Reconcile the current Helm release before preparation",
  );
  mkdirSync(directory, { mode: 0o700 });
  run("scripts/run-release-scope-check.mjs", [scope]);
  const values = structuredClone(live.values);
  let desired,
    catalogRevision = baseline.catalogRevision;
  if (scope !== "catalog") {
    const env = {
      ...process.env,
      PI_CLOUD_BUILD_TAG: version,
      PI_CLOUD_IMAGE_CATALOG: resolve(directory, "images.json"),
    };
    run("scripts/check-docker-build-context.mjs");
    run("scripts/production-kubernetes.mjs", ["build", scope], env);
    run(
      "scripts/generate-release-evidence.mjs",
      [
        "--component",
        scope,
        "--image-version",
        version,
        "--output-dir",
        resolve(directory, "evidence"),
      ],
      env,
    );
    desired = readJson(resolve(directory, "images.json"))[imageReleaseTargets[scope].catalogKey];
    if (scope === "provider") values.provider.image = desired;
    else {
      const target = imageReleaseTargets[scope];
      values.images[target.catalogKey] = {
        ...values.images[target.catalogKey],
        repository: `pi-cloud/${target.imageName}`,
        tag: version,
      };
    }
  } else {
    const config = parseModelCatalogConfiguration(readJson(resolve(input)));
    const previous = parseModelCatalogConfiguration(
      JSON.parse(
        JSON.parse(kubectl(["get", "configmap", "pi-cloud-model-catalog", "-o", "json"])).data[
          "model-catalog.json"
        ],
      ),
    );
    const probes = [];
    for (const model of changedVisibleModels(previous, config)) {
      console.log(
        JSON.stringify({
          phase: "model route probe",
          provider: model.provider,
          model: model.modelId,
        }),
      );
      const apiKey = readFileSync(
        resolve(runtimeDirectory, "secrets/cli-proxy-api-key"),
        "utf8",
      ).trim();
      probes.push(
        await probeCatalogModel({
          model,
          baseUrl: `http://${serviceAddress("cli-proxy-api")}:8317`,
          apiKey,
        }),
      );
    }
    save(resolve(directory, "model-probes.json"), { catalogRevision: digest(config), probes });
    desired = JSON.stringify(config);
    catalogRevision = digest(config);
    values.modelCatalogJson = desired;
    save(resolve(directory, "catalog.json"), config);
  }
  writeFileSync(resolve(directory, "values.yaml"), stringify(values), { mode: 0o600 });
  const rendered = render(name, chart, resolve(directory, "values.yaml"));
  assertScopedManifests(scope, live.manifest, rendered, desired);
  writeFileSync(resolve(directory, "before.yaml"), live.manifest, { mode: 0o600 });
  writeFileSync(resolve(directory, "rendered.yaml"), rendered, { mode: 0o600 });
  save(resolve(directory, "baseline.json"), baseline);
  save(resolve(directory, "candidate.json"), {
    formatVersion: 1,
    scope,
    name,
    chart: resolve(chart),
    version,
    revision,
    desired,
    catalogRevision,
    baselineDigest: digest(baseline),
    helmRevision: live.status.version,
    valuesDigest: digest(readFileSync(resolve(directory, "values.yaml"), "utf8")),
    beforeDigest: digest(live.manifest),
    renderedDigest: digest(rendered),
    ...(scope === "catalog"
      ? { probesDigest: digest(readFileSync(resolve(directory, "model-probes.json"), "utf8")) }
      : {}),
    sourceInputs: Object.fromEntries(
      inputs(scope).map((file) => [file, digest(readFileSync(resolve(root, file), "utf8"))]),
    ),
  });
}

const candidate = readJson(resolve(directory, "candidate.json"));
assert.equal(candidate.formatVersion, 1);
assertOperatorRevisionChanges(
  capture("git", ["diff", "--name-only", `${candidate.revision}..${revision}`])
    .split("\n")
    .filter(Boolean),
);
assertScopedSources(
  candidate.scope,
  capture("git", [
    "diff",
    "--name-only",
    `${readJson(resolve(directory, "baseline.json")).revision}..${revision}`,
  ])
    .split("\n")
    .filter(Boolean),
);
for (const [file, hash] of Object.entries(candidate.sourceInputs))
  assert.equal(digest(readFileSync(resolve(root, file), "utf8")), hash, "Source inputs changed");
for (const [file, key] of [
  ["values.yaml", "valuesDigest"],
  ["before.yaml", "beforeDigest"],
  ["rendered.yaml", "renderedDigest"],
])
  assert.equal(
    digest(readFileSync(resolve(directory, file), "utf8")),
    candidate[key],
    "Candidate changed",
  );
assert.equal(
  digest(render(candidate.name, candidate.chart, resolve(directory, "values.yaml"))),
  digest(readFileSync(resolve(directory, "rendered.yaml"), "utf8")),
  "Rendered inputs changed",
);
assertScopedManifests(
  candidate.scope,
  readFileSync(resolve(directory, "before.yaml"), "utf8"),
  readFileSync(resolve(directory, "rendered.yaml"), "utf8"),
  candidate.desired,
);
const baseline = readJson(resolve(directory, "baseline.json"));
assert.equal(digest(baseline), candidate.baselineDigest);
if (candidate.scope === "control-plane")
  assert.equal(
    baseline.contracts.controlPlaneReplacement,
    1,
    "The installed release lacks the Control Plane replacement contract",
  );
if (candidate.scope === "catalog") {
  assert.equal(
    digest(readFileSync(resolve(directory, "model-probes.json"), "utf8")),
    candidate.probesDigest,
    "Model probe evidence changed",
  );
  const catalog = parseModelCatalogConfiguration(JSON.parse(candidate.desired));
  assert.equal(digest(catalog), candidate.catalogRevision, "Catalog identity changed");
  assert.equal(
    digest(readJson(resolve(directory, "catalog.json"))),
    digest(catalog),
    "Catalog evidence changed",
  );
}
let evidence;
if (candidate.scope !== "catalog") {
  const evidenceDirectory = resolve(directory, "evidence");
  const lines = readFileSync(resolve(evidenceDirectory, "SHA256SUMS"), "utf8").trim().split("\n");
  const covered = new Set();
  for (const line of lines) {
    const m = /^([a-f0-9]{64})  ([A-Za-z0-9_.\/-]+)$/.exec(line);
    assert(m && !m[2].startsWith("/") && !m[2].split("/").includes(".."));
    assert.equal(
      digest(readFileSync(resolve(evidenceDirectory, m[2]), "utf8")),
      m[1],
      "Evidence checksum changed",
    );
    covered.add(m[2]);
  }
  assert(covered.has("manifest.json"));
  evidence = readJson(resolve(evidenceDirectory, "manifest.json"));
  assert.equal(evidence.git.revision, candidate.revision);
  assert.equal(evidence.git.dirty, false);
  assert.equal(evidence.scope, candidate.scope);
  assert.equal(evidence.imageVersion, candidate.version);
  assert.equal(evidence.images.length, 1);
  for (const file of [
    evidence.rootSbom.path,
    evidence.policy.exceptionPolicy.path,
    ...evidence.images.flatMap((i) => [
      i.sbom.path,
      i.vulnerabilityReport.path,
      i.policyVulnerabilityReport.path,
    ]),
  ])
    assert(covered.has(file));
  assert.equal(evidence.images[0].reference, candidate.desired);
  const image = JSON.parse(capture("docker", ["image", "inspect", candidate.desired]))[0];
  assert.equal(image.Id, evidence.images[0].imageId, "Scanned image was replaced");
}
const next = composeScopedDeployment(baseline, {
  ...candidate,
  evidence,
  evidenceDirectory: resolve(directory, "evidence"),
});
const currentDeployment = readJson(deploymentPath);
assertServingCombination(
  baseline,
  candidate.scope !== "catalog"
    ? {
        name: imageReleaseTargets[candidate.scope].imageName,
        reference: candidate.desired,
      }
    : undefined,
  candidate.scope === "catalog" ? candidate.catalogRevision : undefined,
);
const live = installed(candidate.name);
const alreadyApplied =
  scopedApplyState({
    baseline,
    next,
    current: currentDeployment,
    helmRevision: candidate.helmRevision,
    before: readFileSync(resolve(directory, "before.yaml"), "utf8"),
    desired: readFileSync(resolve(directory, "rendered.yaml"), "utf8"),
    live,
  }) === "verify";
const replacementDomain =
  candidate.scope === "control-plane"
    ? readControlPlaneDomain(helmCapture, candidate.name)
    : undefined;
if (candidate.scope === "control-plane") {
  const deployment = JSON.parse(
    kubectl(["get", imageReleaseTargets["control-plane"].workload, "-o", "json"]),
  );
  const receiptPath = resolve(directory, "control-plane-replacement.json");
  if (deployment.spec.replicas === 0) {
    assert(existsSync(receiptPath), "Stopped Control Plane has no candidate replacement receipt");
    const receipt = readJson(receiptPath);
    assert.equal(receipt.uid, deployment.metadata.uid);
    assert.equal(receipt.version, candidate.version);
    assert(["stopping", "stopped", "applying"].includes(receipt.phase));
  } else {
    const snapshot = controlPlaneSnapshot(
      deployment,
      JSON.parse(kubectl(["get", "hpa", "-o", "json"])).items,
      JSON.parse(
        kubectl([
          "get",
          "pods",
          "-l",
          "app.kubernetes.io/component=control-plane,app.kubernetes.io/instance=pi-cloud",
          "-o",
          "json",
        ]),
      ).items,
    );
    const token = readFileSync(
      resolve(runtimeDirectory, "secrets/supervisor-management-token"),
      "utf8",
    ).trim();
    const response = await fetch(
      `http://${snapshot.podIp}:3000/internal/v1/session-publication/replacement`,
      { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000) },
    );
    assert(response.ok, `Control Plane replacement contract unavailable (HTTP ${response.status})`);
    assert.equal((await response.json()).version, 1);
  }
}
console.log(
  JSON.stringify({
    phase: "preflight passed",
    scope: candidate.scope,
    version: candidate.version,
    alreadyApplied,
  }),
);
if (action !== "apply") process.exit(0);
if (candidate.scope !== "catalog" && !alreadyApplied) {
  const archive = resolve(directory, `${candidate.scope}.tar`);
  try {
    execFileSync("docker", ["save", "--output", archive, candidate.desired], { stdio: "inherit" });
    execFileSync(
      "k3s",
      ["ctr", "images", "import", "--label", "io.cri-containerd.pinned=pinned", archive],
      { stdio: "inherit" },
    );
  } finally {
    rmSync(archive, { force: true });
  }
}
save(resolve(directory, "apply-started.json"), {
  version: candidate.version,
  at: new Date().toISOString(),
});
const applyHelm = async () => {
  const latest = installed(candidate.name);
  if (
    manifestDigest(latest.manifest) ===
      manifestDigest(readFileSync(resolve(directory, "rendered.yaml"), "utf8")) &&
    latest.status.info.status === "deployed"
  )
    return;
  execFileSync(
    helm,
    scopedHelmUpgradeArguments({
      name: candidate.name,
      chart: candidate.chart,
      values: resolve(directory, "values.yaml"),
      kubeconfig,
      namespace,
    }),
    { cwd: root, stdio: "inherit" },
  );
};
if (candidate.scope === "control-plane" && !alreadyApplied) {
  const url = new URL(
    readFileSync(resolve(runtimeDirectory, "secrets/database-url"), "utf8").trim(),
  );
  url.hostname = serviceAddress("postgres");
  const database = await createReplacementDatabase(url.toString());
  const target = imageReleaseTargets["control-plane"].workload;
  const receiptPath = resolve(directory, "control-plane-replacement.json");
  const token = readFileSync(
    resolve(runtimeDirectory, "secrets/supervisor-management-token"),
    "utf8",
  ).trim();
  const selector = "app.kubernetes.io/component=control-plane,app.kubernetes.io/instance=pi-cloud";
  const request = async (receipt, action) => {
    const response = await fetch(
      `http://${receipt.podIp}:3000/internal/v1/session-publication/replacement`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ id: receipt.id, action }),
        signal: AbortSignal.timeout(5_000),
      },
    );
    assert(response.ok, `Control Plane replacement admission failed (HTTP ${response.status})`);
    return response.json();
  };
  const { sql } = await import("kysely");
  const owners = async () => {
    const rows = await database
      .selectFrom("sandbox_control_instances")
      .select("instance_id")
      .where("sandbox_domain_id", "=", replacementDomain)
      .where("state", "=", "ready")
      .where("lease_expires_at", ">", sql`clock_timestamp()`)
      .execute();
    assert.equal(rows.length, 1, "Expected exactly one live Sandbox owner before replacement");
    return rows.map((row) => row.instance_id);
  };
  try {
    await replaceControlPlane(
      {
        observe: async () => ({
          deployment: JSON.parse(kubectl(["get", target, "-o", "json"])),
          autoscalers: JSON.parse(kubectl(["get", "hpa", "-o", "json"])).items,
          pods: JSON.parse(kubectl(["get", "pods", "-l", selector, "-o", "json"])).items,
        }),
        owners,
        request,
        save: async (receipt) => {
          save(receiptPath + ".next", receipt);
          renameSync(receiptPath + ".next", receiptPath);
        },
        stop: async () => kubectl(["scale", target, "--current-replicas=1", "--replicas=0"]),
        waitAbsent: async () => {
          if (JSON.parse(kubectl(["get", "pods", "-l", selector, "-o", "json"])).items.length)
            kubectl(["wait", "--for=delete", "pod", "-l", selector, "--timeout=740s"], {
              timeout: 745_000,
            });
        },
        waitOwners: async (ids) => {
          const end = Date.now() + 30_000;
          while (
            ids.length &&
            (
              await database
                .selectFrom("sandbox_control_instances")
                .select("instance_id")
                .where("instance_id", "in", ids)
                .where("state", "=", "ready")
                .where("lease_expires_at", ">", sql`clock_timestamp()`)
                .execute()
            ).length
          ) {
            assert(Date.now() < end, "Old sandbox-owner lease has not closed");
            await delay(250);
          }
        },
        restore: async () => {
          kubectl(["scale", target, "--current-replicas=0", "--replicas=1"]);
          kubectl(["rollout", "status", target, "--timeout=180s"], { timeout: 185_000 });
        },
        apply: applyHelm,
      },
      existsSync(receiptPath) ? readJson(receiptPath) : undefined,
      candidate.version,
    );
  } finally {
    await database.destroy();
  }
} else if (!alreadyApplied || live.status.info.status !== "deployed") await applyHelm();
if (candidate.scope !== "catalog") {
  const workload = imageReleaseTargets[candidate.scope].workload;
  kubectl(["rollout", "status", workload, "--timeout=180s"], {
    timeout: 185_000,
  });
} else {
  const token = readFileSync(resolve(runtimeDirectory, "secrets/api-token"), "utf8").trim();
  const deadline = Date.now() + 180_000;
  for (;;) {
    const pods = JSON.parse(
      kubectl(["get", "pods", "-l", "app.kubernetes.io/component=control-plane", "-o", "json"]),
    ).items.filter((p) => !p.metadata.deletionTimestamp);
    const statuses = await Promise.all(
      pods.map(async (p) => {
        try {
          const response = await fetch(`http://${p.status.podIP}:3000/v1/models`, {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(3000),
          });
          const value = await response.json();
          return response.ok && value.revision === candidate.catalogRevision && !value.reloadFailed;
        } catch {
          return false;
        }
      }),
    );
    if (statuses.length && statuses.every(Boolean)) break;
    assert(
      Date.now() < deadline,
      "Catalog publication has not converged; keep evidence and retry this candidate",
    );
    await delay(1000);
  }
}
const after = installed(candidate.name);
assert.equal(
  manifestDigest(after.manifest),
  manifestDigest(readFileSync(resolve(directory, "rendered.yaml"), "utf8")),
  "Applied Helm manifest differs from candidate",
);
if (candidate.scope !== "catalog") {
  const path = resolve(runtimeDirectory, "k3s/images.json"),
    images = readJson(path);
  images[imageReleaseTargets[candidate.scope].catalogKey] = candidate.desired;
  save(path + ".next", images);
  renameSync(path + ".next", path);
}
save(deploymentPath + ".next", next);
renameSync(deploymentPath + ".next", deploymentPath);
save(resolve(directory, "applied.json"), {
  version: candidate.version,
  scope: candidate.scope,
  helmRevision: after.status.version,
  operatorRevision: revision,
  deploymentDigest: digest(next),
  at: new Date().toISOString(),
});
if (candidate.scope === "provider")
  execFileSync(process.execPath, ["scripts/configure-provider-websockets.mjs"], {
    cwd: root,
    stdio: "inherit",
  });
console.log(
  JSON.stringify({
    phase: "component deployed; run relevant live acceptance",
    scope: candidate.scope,
    version: candidate.version,
  }),
);
