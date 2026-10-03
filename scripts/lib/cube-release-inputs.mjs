import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const execute = promisify(execFile);

/** Export pinned chart/config; never derive desired state from a running Pod. */
export async function prepareCubeRelease({ repositoryRoot, cubeRepository, runtimeDirectory }) {
  const manifest = JSON.parse(
    await readFile(resolve(repositoryRoot, "deploy/cubesandbox/runtime-build.json"), "utf8"),
  );
  const directory = await mkdtemp(join(tmpdir(), "pi-cloud-cube-release-"));
  const close = () => rm(directory, { recursive: true, force: true });
  try {
    const archive = join(directory, "chart.tar");
    await execute("git", [
      "-C",
      cubeRepository,
      "archive",
      "--format=tar",
      `--output=${archive}`,
      manifest.upstreamCommit,
      "deploy/kubernetes/chart",
    ]);
    await execute("tar", ["-xf", archive, "-C", directory]);
    const { stdout: cubeletConfig } = await execute("git", [
      "-C",
      cubeRepository,
      "show",
      `${manifest.upstreamCommit}:Cubelet/config/config.toml`,
    ]);
    const sharedRoot = resolve(runtimeDirectory, "state/cube-shared"),
      metadata = await stat(sharedRoot);
    if (!metadata.isDirectory()) throw new Error("Workspace shared root is not a directory");
    const completionFiles = {};
    for (const name of [
      "database-url",
      "supervisor-management-token",
      "session-image-s3-credentials.json",
    ])
      completionFiles[name] = (await readFile(resolve(runtimeDirectory, "secrets", name))).toString(
        "base64",
      );
    const input = {
      version: 1,
      sharedRoot,
      sharedRootIdentity: `${metadata.dev}-${metadata.ino}`,
      cubeletConfig,
      pluginSource: await readFile(
        resolve(repositoryRoot, "deploy/cubesandbox/cube-volume-picloud-posix.sh"),
        "utf8",
      ),
      completionFiles,
    };
    const inputPath = join(directory, "render-inputs.json");
    await writeFile(inputPath, JSON.stringify(input), { mode: 0o600 });
    return {
      chart: join(directory, "deploy/kubernetes/chart"),
      rendererArgs: [
        "--post-renderer",
        resolve(repositoryRoot, "scripts/render-cube-release.mjs"),
        "--post-renderer-args",
        inputPath,
      ],
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** Only the two previously installer-owned PiCloud objects may be adopted. */
export function cubeAdoptionFlags(objects) {
  let adopt = false;
  const allowed = new Set([
    "ConfigMap/pi-cloud-posix-volume-plugin",
    "Secret/pi-cloud-cube-completion",
  ]);
  for (const object of objects) {
    if (!allowed.has(`${object.kind}/${object.metadata?.name}`))
      throw new Error("Unexpected Cube adoption resource");
    const annotations = object.metadata.annotations ?? {};
    if (
      annotations["meta.helm.sh/release-name"] &&
      (annotations["meta.helm.sh/release-name"] !== "cube" ||
        annotations["meta.helm.sh/release-namespace"] !== "cube-system")
    )
      throw new Error("Cube configuration belongs to a different Helm release");
    if (!annotations["meta.helm.sh/release-name"]) adopt = true;
  }
  return adopt ? ["--take-ownership"] : [];
}
