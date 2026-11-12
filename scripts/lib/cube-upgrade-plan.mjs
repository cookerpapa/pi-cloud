import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  readFile,
  writeFile,
  mkdtemp,
  rm,
  stat,
  lstat,
  chmod,
  chown,
  rename,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { parse, stringify } from "yaml";
import { prepareCubeRelease } from "./cube-release-inputs.mjs";
import { manifestDigest } from "./component-release.mjs";
import {
  cubeReleaseValues,
  pinCubeReleaseValues,
  cubeResources,
  cubeReleaseDigest,
  cubeCredentialData,
  cubeNewCredentialData,
  assertCubeCredentialsRetained,
  assertCubeReleaseManifest,
} from "./cube-release-policy.mjs";
const execute = promisify(execFile);
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = (path, value) =>
  writeFile(path, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });

function tools(options) {
  const helm = process.env.PI_CLOUD_HELM_BIN ?? "helm";
  const binary = process.env.PI_CLOUD_KUBECTL_BIN ?? "/usr/local/bin/k3s";
  const prefix = process.env.PI_CLOUD_KUBECTL_BIN ? [] : ["kubectl"];
  const run = async (command, args, timeout = 120000) => {
    try {
      return (
        await execute(command, args, {
          cwd: options.repositoryRoot,
          timeout,
          maxBuffer: 32 * 1024 * 1024,
        })
      ).stdout;
    } catch (error) {
      if (options.directory)
        await writeFile(
          join(options.directory, "cube-command-error.txt"),
          String(error.stderr ?? error.message ?? "Native command failed"),
          { mode: 0o600 },
        );
      throw new Error(
        options.directory
          ? "Private Cube release command failed; inspect cube-command-error.txt in the private candidate"
          : "Private Cube release command failed; no manifest or credentials were printed",
      );
    }
  };
  const flags = ["--namespace", "cube-system", "--kubeconfig", options.kubeconfig];
  return {
    run,
    helm: (args) => run(helm, [...args, ...flags]),
    kube: (args, timeout) => run(binary, [...prefix, ...flags, ...args], timeout),
  };
}
async function installed(t) {
  const [values, manifest] = await Promise.all([
    t.helm(["get", "values", "cube", "--output", "json"]),
    t.helm(["get", "manifest", "cube"]),
  ]);
  const resources = cubeResources(manifest);
  const names = Object.keys(cubeCredentialData(resources));
  const live = names.length
    ? JSON.parse(await t.kube(["get", ...names.map((name) => `secret/${name}`), "-o", "json"]))
    : { items: [] };
  return {
    values: JSON.parse(values),
    manifest,
    credentials: cubeCredentialData(live.items ?? [live]),
  };
}
async function render(options, valuesPath, overrides) {
  const release = await prepareCubeRelease({ ...options, renderOverrides: overrides });
  try {
    const t = tools(options);
    // Upgrade dry-run enables live Secret lookup. Output is captured privately,
    // never inherited by the terminal; hooks are rendered, never executed.
    const value = JSON.parse(
      await t.helm([
        "upgrade",
        "cube",
        release.chart,
        "--reset-then-reuse-values",
        "--values",
        valuesPath,
        ...release.rendererArgs,
        "--dry-run=server",
        "--output",
        "json",
      ]),
    );
    return {
      manifest: [value.manifest, ...(value.hooks ?? []).map((hook) => hook.manifest)]
        .filter(Boolean)
        .join("\n---\n"),
      appliedValues: value.config,
      inputIdentity: release.inputIdentity,
      sharedRoot: release.sharedRoot,
      sharedRootIdentity: release.sharedRootIdentity,
      defaults: parse(await readFile(join(release.chart, "values.yaml"), "utf8")),
    };
  } finally {
    await release.close();
  }
}
export async function prepareCubeUpgradePlan(options) {
  const { directory, tag } = options,
    t = tools(options);
  const build = await json(
    resolve(options.repositoryRoot, "deploy/cubesandbox/runtime-build.json"),
  );
  const before = await installed(t);
  const values = cubeReleaseValues(before.values, build.upstreamVersion, tag);
  const valuesPath = join(directory, "cube-values.yaml");
  await writeFile(valuesPath, stringify(values, { version: "1.1", directives: false }), {
    mode: 0o600,
  });
  const first = await render(options, valuesPath, {});
  assertCubeReleaseManifest(cubeResources(first.manifest), {
    sharedRoot: first.sharedRoot,
    tag,
    priorResources: cubeResources(before.manifest),
  });
  const credentials = cubeCredentialData(cubeResources(first.manifest));
  assertCubeCredentialsRetained(before.credentials, credentials);
  const credentialAdditions = cubeNewCredentialData(before.credentials, credentials);
  const frozen = await render(options, valuesPath, { credentialAdditions });
  await writeFile(join(directory, "cube-chart.rendered.yaml"), frozen.manifest, { mode: 0o600 });
  await save(join(directory, "cube-plan.pending.json"), {
    formatVersion: 1,
    tag,
    upstreamVersion: build.upstreamVersion,
    upstreamCommit: build.upstreamCommit,
    baselineValuesDigest: cubeReleaseDigest(before.values),
    baselineManifestDigest: manifestDigest(before.manifest),
    credentials: before.credentials,
    credentialAdditions,
    inputIdentity: frozen.inputIdentity,
    sharedRootIdentity: frozen.sharedRootIdentity,
    sharedRoot: frozen.sharedRoot,
    chartManifestDigest: cubeReleaseDigest(frozen.manifest),
  });
}
export async function finalizeCubeUpgradePlan(options) {
  const { directory } = options;
  const plan = await json(join(directory, "cube-plan.pending.json"));
  const evidence = await json(join(directory, "cube-upstream-images.json"));
  const release = await prepareCubeRelease(options);
  let defaults;
  try {
    defaults = parse(await readFile(join(release.chart, "values.yaml"), "utf8"));
  } finally {
    await release.close();
  }
  const initial = parse(await readFile(join(directory, "cube-values.yaml"), "utf8"));
  const values = pinCubeReleaseValues(initial, defaults, evidence);
  const valuesPath = join(directory, "cube-values.yaml");
  await writeFile(valuesPath, stringify(values, { version: "1.1", directives: false }), {
    mode: 0o600,
  });
  const upstreamImagePins = Object.fromEntries(
    evidence.images.map((image) => [image.reference, image.pinnedReference]),
  );
  const final = await render(options, valuesPath, {
    credentialAdditions: plan.credentialAdditions,
    upstreamImagePins,
  });
  assert.equal(
    final.inputIdentity,
    plan.inputIdentity,
    "Cube render inputs changed during preparation",
  );
  assertCubeReleaseManifest(cubeResources(final.manifest), {
    sharedRoot: final.sharedRoot,
    tag: plan.tag,
  });
  const inspect = (value) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.image === "string" && !value.image.startsWith("pi-cloud/"))
      assert.match(
        value.image,
        /^.+@sha256:[0-9a-f]{64}$/,
        "An upstream chart image is not digest-pinned",
      );
    for (const child of Object.values(value)) inspect(child);
  };
  inspect(cubeResources(final.manifest));
  await writeFile(join(directory, "cube-release.rendered.yaml"), final.manifest, { mode: 0o600 });
  assert(
    final.appliedValues && typeof final.appliedValues === "object",
    "Helm dry-run did not expose applied values",
  );
  const complete = {
    ...plan,
    upstreamImagePins,
    valuesFileDigest: cubeReleaseDigest(values),
    valuesDigest: cubeReleaseDigest(final.appliedValues),
    manifestDigest: manifestDigest(final.manifest),
    fullManifestDigest: cubeReleaseDigest(cubeResources(final.manifest)),
    upstreamEvidenceDigest: cubeReleaseDigest(evidence),
  };
  await save(join(directory, "cube-release-plan.json"), complete);
  await rm(join(directory, "cube-plan.pending.json"));
  return cubeReleaseDigest(complete);
}
export function cubeUpgradeAlreadyApplied(plan, live, desired) {
  const desiredManifest = cubeResources(desired)
    .filter((resource) => !resource.metadata?.annotations?.["helm.sh/hook"])
    .map((resource) => stringify(resource))
    .join("---\n");
  // Retaining the native image tag/Helm values does not retain generated plugin
  // or post-rendered configuration. Only the full desired state proves apply.
  if (
    cubeReleaseDigest(live.values) === plan.valuesDigest &&
    manifestDigest(live.manifest) === manifestDigest(desiredManifest)
  )
    return true;
  assert.equal(
    cubeReleaseDigest(live.values),
    plan.baselineValuesDigest,
    "Installed Cube overrides changed",
  );
  assert.equal(
    manifestDigest(live.manifest),
    plan.baselineManifestDigest,
    "Installed Cube manifest changed",
  );
  return false;
}

export async function verifyCubeUpgradePlan(options) {
  const { directory, tag } = options,
    t = tools(options);
  const plan = await json(join(directory, "cube-release-plan.json"));
  assert.equal(plan.formatVersion, 1);
  assert.equal(plan.tag, tag);
  if (options.expectedDigest)
    assert.equal(cubeReleaseDigest(plan), options.expectedDigest, "Native release plan changed");
  assert.equal(
    cubeReleaseDigest(await readFile(join(directory, "cube-chart.rendered.yaml"), "utf8")),
    plan.chartManifestDigest,
  );
  assert.equal(
    cubeReleaseDigest(await json(join(directory, "cube-upstream-images.json"))),
    plan.upstreamEvidenceDigest,
  );
  const prepared = await readFile(join(directory, "cube-release.rendered.yaml"), "utf8");
  assert.equal(cubeReleaseDigest(cubeResources(prepared)), plan.fullManifestDigest);
  const desired = prepared;
  assert.equal(manifestDigest(desired), plan.manifestDigest);
  const values = parse(await readFile(join(directory, "cube-values.yaml"), "utf8"));
  assert.equal(cubeReleaseDigest(values), plan.valuesFileDigest);
  const live = await installed(t);
  assertCubeCredentialsRetained(plan.credentials, live.credentials);
  if (cubeUpgradeAlreadyApplied(plan, live, desired)) {
    return { plan, alreadyApplied: true, manifest: desired };
  }
  const next = await render(options, join(directory, "cube-values.yaml"), {
    credentialAdditions: plan.credentialAdditions,
    upstreamImagePins: plan.upstreamImagePins,
  });
  assert.equal(
    next.inputIdentity,
    plan.inputIdentity,
    "Cube credentials/configuration or Workspace backing root changed",
  );
  assert.equal(
    cubeReleaseDigest(cubeResources(next.manifest)),
    plan.fullManifestDigest,
    "Pinned full chart no longer reproduces the candidate",
  );
  assertCubeReleaseManifest(cubeResources(next.manifest), {
    sharedRoot: next.sharedRoot,
    tag,
    priorResources: cubeResources(live.manifest),
  });
  assertCubeCredentialsRetained(plan.credentials, cubeCredentialData(cubeResources(next.manifest)));
  return { plan, alreadyApplied: false, manifest: desired };
}

/** Copy only the Ready CLI image pinned by the same rendered native release. */
export async function refreshCubeMasterCli(options, renderedManifest) {
  const t = tools(options),
    resources = cubeResources(renderedManifest);
  const deployment = resources.find(
    (resource) =>
      resource.kind === "Deployment" &&
      resource.spec.template.spec.containers.some(
        (container) => container.name === "cubemastercli",
      ),
  );
  assert(deployment, "The pinned chart has no operator CLI Deployment");
  const image = deployment.spec.template.spec.containers.find(
    (container) => container.name === "cubemastercli",
  ).image;
  assert.match(image, /@sha256:[0-9a-f]{64}$/);
  await t.kube(
    ["rollout", "status", `deployment/${deployment.metadata.name}`, "--timeout=180s"],
    185000,
  );
  const pods = JSON.parse(
    await t.kube([
      "get",
      "pods",
      "-l",
      "app.kubernetes.io/instance=cube,app.kubernetes.io/component=cubemastercli",
      "-o",
      "json",
    ]),
  ).items;
  const pod = pods.find(
    (pod) =>
      !pod.metadata.deletionTimestamp &&
      pod.spec.containers.some(
        (container) => container.name === "cubemastercli" && container.image === image,
      ) &&
      pod.status.containerStatuses?.some(
        (container) =>
          container.name === "cubemastercli" && container.ready && container.state?.running,
      ),
  );
  assert(pod, "Matching native CLI Pod is not Ready");
  const version = await t.kube([
    "exec",
    pod.metadata.name,
    "-c",
    "cubemastercli",
    "--",
    "/usr/local/bin/cubemastercli",
    "--version",
  ]);
  const build = await json(
    resolve(options.repositoryRoot, "deploy/cubesandbox/runtime-build.json"),
  );
  assert(version.includes(build.upstreamVersion), "Native CLI reports a different version");
  const scratch = await mkdtemp(join(options.runtimeDirectory, "cubesandbox/.cli-"));
  try {
    const target = join(scratch, "cubemastercli");
    await t.kube([
      "cp",
      "-c",
      "cubemastercli",
      `${pod.metadata.name}:/usr/local/bin/cubemastercli`,
      target,
    ]);
    const metadata = await lstat(target),
      owner = await stat(join(options.runtimeDirectory, "secrets/cubesandbox-api-key"));
    assert(
      metadata.isFile() &&
        !metadata.isSymbolicLink() &&
        metadata.size > 1000000 &&
        metadata.size < 128 * 1024 * 1024,
    );
    await chown(target, owner.uid, owner.gid);
    await chmod(target, 0o700);
    const sha256 = cubeReleaseDigest(await readFile(target));
    await rename(target, join(options.runtimeDirectory, "cubesandbox/cubemastercli"));
    await save(join(options.runtimeDirectory, "cubesandbox/cubemastercli.json"), {
      image,
      sha256,
      version: version.trim(),
      upstreamCommit: build.upstreamCommit,
    });
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
