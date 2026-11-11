import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { configureBuildProxy } from "./lib/upstream-proxy.mjs";
import { serializeRelease } from "./lib/release-lock.mjs";
import {
  runtimeDirectory,
  kubectl,
  kubeconfig,
  namespace,
  runtimeEnvironment,
} from "./lib/production-kubernetes.mjs";
import { assertBoxLiteEmpty } from "./lib/boxlite-maintenance.mjs";
import { DEVELOPMENT_ENVIRONMENT_PROFILES } from "../packages/protocol/src/development-environment-profile.ts";
configureBuildProxy();
serializeRelease(runtimeDirectory);
const [action, path, version, base, guest] = process.argv.slice(2),
  directory = resolve(path ?? "");
assert(
  ["prepare", "apply"].includes(action) && path,
  "Use prepare DIRECTORY VERSION CONTROL_IMAGE GUEST_IMAGE or apply DIRECTORY",
);
const run = (bin, args) => execFileSync(bin, args, { stdio: "inherit" });
const capture = (bin, args) => execFileSync(bin, args, { encoding: "utf8" }).trim();
const revision = capture("git", ["rev-parse", "HEAD"]);
assert.equal(
  capture("git", ["status", "--porcelain", "--untracked-files=all"]),
  "",
  "Commit reviewed source first",
);
const manifest = resolve(directory, "boxlite-release.json");
if (action === "prepare") {
  assert(
    /^[a-z0-9][a-z0-9.-]{0,90}$/.test(version ?? "") && base && guest,
    "Supply matched image references",
  );
  assert(!existsSync(directory), "Use a fresh candidate directory");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  run("docker", [
    "build",
    "--network=host",
    "-f",
    "packages/boxlite-node/Dockerfile",
    "-t",
    `pi-cloud/boxlite-node:${version}`,
    "--build-arg",
    "HTTP_PROXY",
    "--build-arg",
    "HTTPS_PROXY",
    "--build-arg",
    "NO_PROXY",
    "--build-arg",
    `PI_CLOUD_CONTROL_IMAGE=${base}`,
    "--build-arg",
    `PI_CLOUD_VERSION=${version}`,
    "--build-arg",
    `PI_CLOUD_REVISION=${revision}`,
    ".",
  ]);
  run(process.execPath, [
    "scripts/generate-release-evidence.mjs",
    "--component",
    "boxlite",
    "--image-version",
    version,
    "--output-dir",
    resolve(directory, "evidence"),
  ]);
  const guestImageId = JSON.parse(capture("docker", ["inspect", guest]))[0].Id;
  writeFileSync(
    manifest,
    JSON.stringify({ revision, version, base, guest, guestImageId }, null, 2) + "\n",
    { mode: 0o600 },
  );
} else {
  const release = JSON.parse(readFileSync(manifest));
  assert.equal(release.revision, revision);
  const evidence = JSON.parse(readFileSync(resolve(directory, "evidence/manifest.json")));
  assert.equal(evidence.scope, "boxlite");
  assert.equal(evidence.git.revision, revision);
  assert.equal(evidence.images.length, 1);
  const image = evidence.images[0];
  assert.equal(
    image.policyVulnerabilities.HIGH.fixable + image.policyVulnerabilities.CRITICAL.fixable,
    0,
  );
  assert.equal(JSON.parse(capture("docker", ["inspect", image.reference]))[0].Id, image.imageId);
  assert.equal(
    JSON.parse(capture("docker", ["inspect", release.guest]))[0].Id,
    release.guestImageId,
  );
  const nodes = JSON.parse(kubectl(["get", "nodes", "-o", "json"])).items;
  assert.equal(nodes.length, 1, "This operator installs one explicitly owned BoxLite node");
  const nodeName = nodes[0].metadata.name,
    nodeId = "boxlite-" + nodeName;
  // A provider selected by a live resource manager cannot be replaced beneath
  // that manager. The matched operator stops admission and retires compute first.
  const managers = JSON.parse(kubectl(["get", "pods", "-o", "json"])).items.filter((p) =>
    ["control-plane", "session-runtime"].includes(
      p.metadata.labels?.["app.kubernetes.io/component"],
    ),
  );
  assert(
    !managers.some((p) =>
      p.spec.containers.some((c) =>
        c.env?.some((e) => e.name === "PI_CLOUD_SANDBOX_PROVIDER" && e.value === "boxlite"),
      ),
    ),
    "Stop BoxLite resource admission through the matched maintenance procedure before replacing its node",
  );
  await assertBoxLiteEmpty({ kubectl });
  const registry =
    JSON.parse(kubectl(["get", "service", "pi-cloud-cube-template-registry", "-o", "json"])).spec
      .clusterIP + ":5000";
  run("docker", ["push", release.guest]);
  const local = JSON.parse(capture("docker", ["inspect", release.guest]))[0];
  const digest = local.RepoDigests?.find((v) =>
    v.startsWith("localhost:5000/pi-cloud/cubesandbox-tool@"),
  )?.split("@")[1];
  assert(/^sha256:[a-f0-9]{64}$/.test(digest ?? ""), "Guest OCI digest is unavailable");
  const guestRef = registry + "/pi-cloud/cubesandbox-tool@" + digest;
  kubectl(["apply", "-f", "deploy/cubesandbox/template-registry.yaml"]);
  const cluster = JSON.parse(readFileSync(resolve(runtimeDirectory, "cubesandbox/cluster.json")));
  const completion = JSON.parse(kubectl(["get", "service", "tool-completion", "-o", "json"])).spec
    .clusterIP;
  const gateway = runtimeEnvironment().PI_CLOUD_CUBESANDBOX_EGRESS_PROXY_HOST ?? "10.255.255.254";
  const profiles = {
    tool: { image: guestRef, cpus: 1, memoryMiB: 1024, diskGiB: 8 },
    ...Object.fromEntries(
      DEVELOPMENT_ENVIRONMENT_PROFILES.map((p) => [
        p.key,
        { image: guestRef, cpus: p.cpuCount, memoryMiB: p.memoryMiB, diskGiB: p.systemDiskGiB },
      ]),
    ),
  };
  const state = resolve(runtimeDirectory, "state/boxlite-node");
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const values = {
    nodeName,
    nodeId,
    image: image.reference,
    dataDirectory: state,
    workspacePoolDirectory: resolve(runtimeDirectory, "state/cube-shared/volume"),
    replicas: 1,
    profiles,
    registries: [{ host: registry, transport: "https", skipVerify: true }],
    allowedAddresses: [`${completion}/32`, `${gateway}/32`],
  };
  // skipVerify applies only to this private, digest-pinned registry; no global
  // TLS or image identity policy is weakened.
  const valuesPath = resolve(directory, "values.json");
  writeFileSync(valuesPath, JSON.stringify(values, null, 2) + "\n", { mode: 0o600 });
  const archive = resolve(directory, "boxlite-node.tar");
  try {
    run("docker", ["save", "-o", archive, image.reference]);
    run("/usr/local/bin/k3s", [
      "ctr",
      "images",
      "import",
      "--label",
      "io.cri-containerd.pinned=pinned",
      archive,
    ]);
  } finally {
    rmSync(archive, { force: true });
  }
  const prior = JSON.parse(
    kubectl(["get", "pods", "-l", "app.kubernetes.io/instance=pi-cloud-boxlite", "-o", "json"]),
  ).items;
  run("helm", [
    "upgrade",
    "--install",
    "pi-cloud-boxlite",
    "deploy/helm/pi-cloud-boxlite",
    "--namespace",
    namespace,
    "--kubeconfig",
    kubeconfig,
    "-f",
    valuesPath,
  ]);
  for (const p of prior)
    kubectl(["delete", "pod", p.metadata.name, "--wait=true", "--timeout=120s"]);
  let ready;
  const deadline = Date.now() + 180000;
  while (!ready && Date.now() < deadline) {
    ready = JSON.parse(
      kubectl(["get", "pods", "-l", "app.kubernetes.io/instance=pi-cloud-boxlite", "-o", "json"]),
    ).items.find(
      (p) =>
        !p.metadata.deletionTimestamp &&
        !prior.some((o) => o.metadata.uid === p.metadata.uid) &&
        p.status.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
    );
    if (!ready) await delay(1000);
  }
  assert(ready, "BoxLite API did not become ready; no provider fallback is authorized");
  writeFileSync(
    resolve(runtimeDirectory, "k3s/boxlite.json"),
    JSON.stringify(
      {
        revision,
        version: release.version,
        nodeId,
        url: "http://pi-cloud-boxlite:8091",
        valuesPath,
        guest: guestRef,
        clusterNode: cluster.nodeName,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  console.log(JSON.stringify({ installed: true, nodeId, providerSelected: false }));
}
