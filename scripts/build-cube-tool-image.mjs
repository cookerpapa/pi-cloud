import { configureBuildProxy } from "./lib/upstream-proxy.mjs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { guestBuildIdentity } from "./lib/guest-build-identity.mjs";
import { inspectReleaseImage } from "./lib/release-image-evidence.mjs";
import { startRegistryForward } from "./lib/cube-registry-forward.mjs";
import { runtimeDirectory } from "./lib/production-kubernetes.mjs";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

configureBuildProxy();

const root = fileURLToPath(new URL("..", import.meta.url));
const capture = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
if (capture(["status", "--porcelain", "--untracked-files=all"]))
  throw new Error("Commit PiCloud changes before building immutable guest artifacts");
const sourceRevision = capture(["rev-parse", "HEAD"]);
const identity = await guestBuildIdentity(root);
const image = `localhost:5000/pi-cloud/cubesandbox-tool:${identity}`;
const proxyArgs = ["HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy"]
  .filter((name) => process.env[name])
  .flatMap((name) => ["--build-arg", name]);
const catalog = await readFile(join(runtimeDirectory, "cubesandbox/template.json"), "utf8")
  .then(JSON.parse)
  .catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
const reused = catalog?.imageRevision === identity;
if (reused) {
  if (!/^sha256:[a-f0-9]{64}$/.test(catalog.imageDigest))
    throw new Error("Invalid registered guest digest");
  const registered = `localhost:5000/pi-cloud/cubesandbox-tool@${catalog.imageDigest}`;
  try {
    execFileSync("docker", ["image", "inspect", registered], { stdio: "ignore" });
  } catch {
    const cluster = JSON.parse(
      await readFile(join(runtimeDirectory, "cubesandbox/cluster.json"), "utf8"),
    );
    const forward = await startRegistryForward(cluster.registry);
    const config = await mkdtemp(join(tmpdir(), "pi-cloud-guest-pull-"));
    try {
      await writeFile(join(config, "config.json"), "{}\n", { mode: 0o600 });
      // A live Node TCP forward must keep its event loop available during pull.
      const { spawn } = await import("node:child_process");
      await new Promise((resolve, reject) => {
        const child = spawn("docker", ["pull", registered], {
          stdio: "inherit",
          env: { ...process.env, DOCKER_CONFIG: config },
        });
        child.once("error", reject);
        child.once("exit", (code) =>
          code === 0 ? resolve() : reject(new Error("Registered guest pull failed")),
        );
      });
    } finally {
      await forward.stop();
      await rm(config, { recursive: true, force: true });
    }
  }
  await inspectReleaseImage(
    {
      reference: registered,
      labelVersion: "cube-primary",
      releaseRevision: sourceRevision,
      repositoryRoot: root,
      guestIdentity: identity,
    },
    (command, args) => execFileSync(command, args, { encoding: "utf8" }),
  );
  execFileSync("docker", ["tag", registered, image]);
} else
  execFileSync(
    "docker",
    [
      "build",
      "--network=host",
      ...proxyArgs,
      "--file",
      "deploy/cubesandbox/Dockerfile.tool",
      "--build-arg",
      "PI_CLOUD_VERSION=cube-primary",
      "--build-arg",
      `PI_CLOUD_REVISION=${sourceRevision}`,
      "--build-arg",
      `PI_CLOUD_IMAGE_REVISION=${identity}`,
      "--tag",
      image,
      ".",
    ],
    { cwd: root, stdio: "inherit" },
  );
execFileSync(process.execPath, ["scripts/run-cubesandbox-template-check.mjs"], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    PI_CLOUD_CUBESANDBOX_TOOL_IMAGE: image,
    PI_CLOUD_IMAGE_REVISION: identity,
  },
});
// Building never registers/prunes a native template or changes serving config.
process.stdout.write(
  JSON.stringify({ image, identity, releaseRevision: sourceRevision, reused }) + "\n",
);
