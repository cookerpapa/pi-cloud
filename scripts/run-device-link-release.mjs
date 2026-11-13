import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { configureBuildProxy } from "./lib/upstream-proxy.mjs";
import { serializeRelease } from "./lib/release-lock.mjs";
import { runtimeDirectory, kubectl, kubeconfig, namespace } from "./lib/production-kubernetes.mjs";

configureBuildProxy();
serializeRelease(runtimeDirectory);
const [action, path, version] = process.argv.slice(2);
assert(
  path && ["prepare", "apply"].includes(action),
  "Use prepare DIRECTORY VERSION or apply DIRECTORY",
);
const directory = resolve(path),
  manifest = resolve(directory, "device-link-release.json");
const capture = (bin, args) =>
  execFileSync(bin, args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).trim();
const run = (bin, args) => execFileSync(bin, args, { stdio: "inherit" });
const revision = capture("git", ["rev-parse", "HEAD"]);
assert.equal(
  capture("git", ["status", "--porcelain", "--untracked-files=all"]),
  "",
  "Commit reviewed source before publication",
);
if (action === "prepare") {
  assert(/^[a-z0-9][a-z0-9.-]{0,90}$/.test(version ?? ""), "Supply a release version");
  assert(!existsSync(directory), "Use a fresh release directory");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const image = `pi-cloud/device-link:${version}`;
  run("docker", [
    "build",
    "--network=host",
    "-f",
    "packages/device-link/Dockerfile",
    "-t",
    image,
    "--build-arg",
    `PI_CLOUD_VERSION=${version}`,
    "--build-arg",
    `PI_CLOUD_REVISION=${revision}`,
    "--build-arg",
    "HTTP_PROXY",
    "--build-arg",
    "HTTPS_PROXY",
    "--build-arg",
    "NO_PROXY",
    ".",
  ]);
  run(process.execPath, [
    "scripts/generate-release-evidence.mjs",
    "--component",
    "device-link",
    "--image-version",
    version,
    "--output-dir",
    resolve(directory, "evidence"),
  ]);
  writeFileSync(manifest, JSON.stringify({ revision, image, version }) + "\n", { mode: 0o600 });
} else {
  const release = JSON.parse(readFileSync(manifest, "utf8"));
  assert.equal(release.revision, revision, "Apply the reviewed source revision");
  const evidence = JSON.parse(readFileSync(resolve(directory, "evidence/manifest.json"), "utf8"));
  assert.equal(evidence.scope, "device-link");
  assert.equal(evidence.git.revision, revision);
  assert.equal(evidence.images.length, 1);
  const image = evidence.images[0];
  assert.equal(image.reference, release.image);
  assert.equal(
    image.policyVulnerabilities.HIGH.fixable + image.policyVulnerabilities.CRITICAL.fixable,
    0,
  );
  assert.equal(JSON.parse(capture("docker", ["inspect", image.reference]))[0].Id, image.imageId);
  const archive = resolve(directory, "device-link.tar");
  run("docker", ["save", "-o", archive, release.image]);
  run("/usr/local/bin/k3s", ["ctr", "images", "import", archive]);
  const credentials = resolve(runtimeDirectory, "secrets/device-link-devices.json");
  if (!existsSync(credentials)) {
    const existing = JSON.parse(
      kubectl([
        "get",
        "secret",
        "pi-cloud-device-link-credentials",
        "--ignore-not-found",
        "-o",
        "json",
      ]) || "null",
    );
    const content = existing
      ? Buffer.from(existing.data["devices.json"], "base64").toString("utf8")
      : "{}\n";
    writeFileSync(credentials, content, { mode: 0o600 });
  }
  const devices = JSON.parse(readFileSync(credentials, "utf8"));
  assert(
    devices && typeof devices === "object" && !Array.isArray(devices),
    "Invalid device credentials",
  );
  kubectl(["apply", "-f", "-"], {
    input: JSON.stringify({
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "pi-cloud-device-link-credentials", namespace },
      type: "Opaque",
      stringData: { "devices.json": JSON.stringify(devices) },
    }),
    stdio: ["pipe", "inherit", "inherit"],
  });
  run("helm", [
    "upgrade",
    "--install",
    "pi-cloud-device-link",
    "deploy/helm/pi-cloud-device-link",
    "--kubeconfig",
    kubeconfig,
    "--namespace",
    namespace,
    "--set-string",
    `image=${release.image}`,
    "--wait",
    "--timeout",
    "180s",
  ]);
  writeFileSync(
    resolve(directory, "applied.json"),
    JSON.stringify({
      revision,
      image: release.image,
      imageId: image.imageId,
      at: new Date().toISOString(),
    }) + "\n",
    { mode: 0o600 },
  );
}
