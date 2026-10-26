import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { configureBuildProxy } from "./lib/upstream-proxy.mjs";
import { serializeRelease } from "./lib/release-lock.mjs";
import {
  runtimeDirectory,
  kubectl,
  kubeconfig,
  namespace,
  execIn,
} from "./lib/production-kubernetes.mjs";
configureBuildProxy();
serializeRelease(runtimeDirectory);
const [action, path, arg, base] = process.argv.slice(2),
  directory = resolve(path ?? "");
assert(
  ["prepare", "apply"].includes(action) && path,
  "Usage: prepare CANDIDATE VERSION CONTROL_IMAGE | apply CANDIDATE TARGET_DIRECTORY TENANT_UUID",
);
const run = (bin, args, options = {}) => execFileSync(bin, args, { stdio: "inherit", ...options });
const capture = (bin, args) => execFileSync(bin, args, { encoding: "utf8" }).trim();
const revision = capture("git", ["rev-parse", "HEAD"]);
assert.equal(
  capture("git", ["status", "--porcelain", "--untracked-files=all"]),
  "",
  "Commit reviewed source first",
);
const manifestPath = resolve(directory, "android-release.json");
if (action === "prepare") {
  assert(
    /^[a-z0-9][a-z0-9.-]{0,90}$/.test(arg ?? "") && base,
    "Supply version and matched Control Plane image",
  );
  assert(!existsSync(directory), "Use a new candidate directory");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const version = arg;
  for (const [image, file, context] of [
    ["android-runtime", "deploy/android/runtime/Dockerfile", "deploy/android/runtime"],
    ["android-automation", "deploy/android/automation/Dockerfile", "."],
    ["android-executor", "packages/android-executor/Dockerfile", "."],
    ["android-egress", "packages/cube-egress-gateway/Dockerfile", "."],
  ])
    run("docker", [
      "build",
      "--network=host",
      "-f",
      file,
      "-t",
      `pi-cloud/${image}:${version}`,
      "--build-arg",
      "HTTP_PROXY",
      "--build-arg",
      "HTTPS_PROXY",
      "--build-arg",
      "NO_PROXY",
      "--build-arg",
      `PI_CLOUD_VERSION=${version}`,
      "--build-arg",
      `PI_CLOUD_REVISION=${revision}`,
      ...(image === "android-executor" ? ["--build-arg", `PI_CLOUD_CONTROL_IMAGE=${base}`] : []),
      context,
    ]);
  run(process.execPath, [
    "scripts/generate-release-evidence.mjs",
    "--component",
    "android",
    "--image-version",
    version,
    "--output-dir",
    resolve(directory, "evidence"),
  ]);
  writeFileSync(manifestPath, JSON.stringify({ revision, version, base }, null, 2) + "\n", {
    mode: 0o600,
  });
} else {
  assert(arg && base, "Supply the owned target directory and tenant UUID");
  const release = JSON.parse(readFileSync(manifestPath));
  assert.equal(release.revision, revision);
  const evidence = JSON.parse(readFileSync(resolve(directory, "evidence/manifest.json")));
  assert.equal(evidence.scope, "android");
  assert.equal(evidence.git.revision, revision);
  assert.equal(evidence.images.length, 4);
  const targetDirectory = resolve(arg),
    target = JSON.parse(readFileSync(resolve(targetDirectory, "target.json")));
  assert(/^[a-f0-9-]{36}$/.test(target.targetId) && /^[a-f0-9-]{36}$/.test(base));
  // Full schema/Worker cutover precedes admitting this first external target.
  const adminArgs = [
    "node",
    "/app/node_modules/tsx/dist/cli.mjs",
    "--tsconfig",
    "/app/packages/control-plane/tsconfig.json",
    "/app/packages/control-plane/src/execution-target-admin.ts",
  ];
  execIn("control-plane", [...adminArgs, "check", target.targetId, base]);
  const images = {};
  for (const image of evidence.images) {
    assert.equal(
      image.policyVulnerabilities.HIGH.fixable + image.policyVulnerabilities.CRITICAL.fixable,
      0,
    );
    assert.equal(JSON.parse(capture("docker", ["inspect", image.reference]))[0].Id, image.imageId);
    const archive = resolve(directory, image.reference.split("/").at(-1).split(":")[0] + ".tar");
    run("docker", ["save", "-o", archive, image.reference]);
    run("/usr/local/bin/k3s", [
      "ctr",
      "images",
      "import",
      "--label",
      "io.cri-containerd.pinned=pinned",
      archive,
    ]);
    images[image.reference.split("/").at(-1).split(":")[0].replace("android-", "")] =
      image.reference;
  }
  const nodes = JSON.parse(kubectl(["get", "nodes", "-o", "json"])).items;
  assert.equal(
    nodes.length,
    1,
    "For multi-node installation specify an owned local PV and compute node explicitly",
  );
  const name = "pi-android-" + target.targetId.slice(0, 8);
  const values = {
    targetId: target.targetId,
    nodeName: nodes[0].metadata.name,
    vsockCid: target.vsockCid ?? 20003,
    artifactDirectory: resolve(targetDirectory, "artifacts"),
    hostDirectory: resolve(targetDirectory, "host"),
    stateDirectory: resolve(targetDirectory, "state"),
    images,
    existingSecret: "pi-cloud-platform-secrets",
    controlPlaneUrl: "http://control-plane:8080",
    kafkaBrokers: "kafka-1:9092,kafka-2:9092,kafka-3:9092",
    imageEndpoint: "http://session-images:8333",
    imageBucket: "pi-cloud-session-images",
  };
  writeFileSync(resolve(directory, "values.json"), JSON.stringify(values, null, 2) + "\n", {
    mode: 0o600,
  });
  const previous = JSON.parse(
    kubectl(["get", "pods", "-l", "app.kubernetes.io/instance=" + name, "-o", "json"]),
  ).items;
  run("helm", [
    "upgrade",
    "--install",
    name,
    "deploy/helm/pi-cloud-android",
    "--namespace",
    namespace,
    "--kubeconfig",
    kubeconfig,
    "-f",
    resolve(directory, "values.json"),
  ]);
  // OnDelete preserves a running device until admission has been checked above.
  if (previous.length && previous[0].status?.phase === "Running")
    kubectl(["delete", "pod", previous[0].metadata.name, "--wait=true", "--timeout=120s"]);
  run("/usr/local/bin/k3s", [
    "kubectl",
    "--kubeconfig",
    kubeconfig,
    "-n",
    namespace,
    "rollout",
    "status",
    "statefulset/" + name,
    "--timeout=600s",
  ]);
  execIn("control-plane", [
    ...adminArgs,
    "register",
    target.targetId,
    base,
    target.name ?? "Android",
    `http://${name}:8090`,
  ]);
  writeFileSync(
    resolve(targetDirectory, "deployment.json"),
    JSON.stringify(
      { release: directory, revision, tenantId: base, name, at: new Date().toISOString() },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ ready: true, targetId: target.targetId, name }));
}
