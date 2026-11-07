import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile, writeFile, stat, chown, rename } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { prepareCubeRelease, cubeAdoptionFlags } from "./lib/cube-release-inputs.mjs";
import { verifyCubeUpgradePlan, refreshCubeMasterCli } from "./lib/cube-upgrade-plan.mjs";
import { cubeReleaseDigest } from "./lib/cube-release-policy.mjs";
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);
if (!process.env.PI_CLOUD_CUBE_RELEASE_DIRECTORY || !process.env.PI_CLOUD_CUBE_IMAGE_VERSION)
  throw new Error(
    "Cube reconciliation requires the prepared matched native release directory and image version",
  );
const options = {
  repositoryRoot,
  runtimeDirectory,
  directory: resolve(process.env.PI_CLOUD_CUBE_RELEASE_DIRECTORY),
  tag: process.env.PI_CLOUD_CUBE_IMAGE_VERSION,
  cubeRepository: resolve(
    process.env.PI_CLOUD_CUBESANDBOX_REPOSITORY ?? resolve(repositoryRoot, "../CubeSandbox"),
  ),
  kubeconfig:
    process.env.PI_CLOUD_CUBE_COMPLETION_KUBECONFIG ??
    resolve(runtimeDirectory, "k3s/kubeconfig.yaml"),
};
const execute = promisify(execFile);
const binary = process.env.PI_CLOUD_KUBECTL_BIN ?? "/usr/local/bin/k3s",
  prefix = process.env.PI_CLOUD_KUBECTL_BIN ? [] : ["kubectl"];
const capture = async (command, args, timeout = 120000) => {
  try {
    return (
      await execute(command, args, { cwd: repositoryRoot, maxBuffer: 32 * 1024 * 1024, timeout })
    ).stdout;
  } catch {
    throw new Error("Native Cube reconciliation failed; no private manifest was printed");
  }
};
const kube = (args) =>
  capture(binary, [...prefix, "--kubeconfig", options.kubeconfig, "-n", "cube-system", ...args]);
for (const name of ["postgres", "session-images", "kafka-1", "kafka-2", "kafka-3"]) {
  const service = JSON.parse(await kube(["get", "service", name, "-o", "json"]));
  if (!Object.keys(service.spec?.selector ?? {}).length)
    throw new Error(`Native completion requires selector-backed ${name}`);
}
const candidate = JSON.parse(await readFile(resolve(options.directory, "candidate.json"), "utf8"));
const verified = await verifyCubeUpgradePlan({
  ...options,
  expectedDigest: candidate.cubeReleasePlanDigest,
});
if (!verified.alreadyApplied) {
  const release = await prepareCubeRelease({
    ...options,
    validation: { binary, prefix, kubeconfig: options.kubeconfig },
    renderOverrides: {
      credentialAdditions: verified.plan.credentialAdditions,
      upstreamImagePins: verified.plan.upstreamImagePins,
    },
  });
  try {
    const objects = JSON.parse(
      await kube([
        "get",
        "configmap/pi-cloud-posix-volume-plugin",
        "secret/pi-cloud-cube-completion",
        "--ignore-not-found",
        "-o",
        "json",
      ]),
    );
    await capture(
      process.env.PI_CLOUD_HELM_BIN ?? "helm",
      [
        "upgrade",
        "cube",
        release.chart,
        "--namespace",
        "cube-system",
        "--kubeconfig",
        options.kubeconfig,
        "--reset-then-reuse-values",
        "--values",
        resolve(options.directory, "cube-values.yaml"),
        ...release.rendererArgs,
        ...cubeAdoptionFlags(objects.items ?? (objects.kind ? [objects] : [])),
        "--wait",
        "--timeout",
        "15m",
      ],
      910000,
    );
  } finally {
    await release.close();
  }
}
await refreshCubeMasterCli(options, verified.manifest);
const path = resolve(runtimeDirectory, "cubesandbox/cluster.json"),
  owner = await stat(path);
const cluster = JSON.parse(await readFile(path, "utf8"));
const buildBytes = await readFile(resolve(repositoryRoot, "deploy/cubesandbox/runtime-build.json"));
const build = JSON.parse(buildBytes.toString());
const next = {
  ...cluster,
  cubeCommit: build.upstreamCommit,
  upstreamVersion: build.upstreamVersion,
  executionProtocolVersion: build.managedProtocolVersion,
  runtimePatchSha256: cubeReleaseDigest(buildBytes),
  nativeReleasePlanDigest: candidate.cubeReleasePlanDigest,
};
await writeFile(path + ".next", JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
await chown(path + ".next", owner.uid, owner.gid);
await rename(path + ".next", path);
process.stdout.write("Complete pinned Cube release and operator CLI reconciled through Helm\n");
