import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCubeRelease, cubeAdoptionFlags } from "./lib/cube-release-inputs.mjs";
import { cubeNativeImageArguments } from "./lib/cube-execution-deployment.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);
const cubeRepository = resolve(
  repositoryRoot,
  process.env.PI_CLOUD_CUBESANDBOX_REPOSITORY ?? "../CubeSandbox",
);
const kubeconfig =
  process.env.PI_CLOUD_CUBE_COMPLETION_KUBECONFIG ??
  resolve(runtimeDirectory, "k3s/kubeconfig.yaml");
const kubectl = process.env.PI_CLOUD_KUBECTL_BIN ?? "/usr/local/bin/k3s";
const prefix = process.env.PI_CLOUD_KUBECTL_BIN ? [] : ["kubectl"];
const env = { ...process.env, KUBECONFIG: kubeconfig };
const images = cubeNativeImageArguments(process.env.PI_CLOUD_CUBE_IMAGE_VERSION);
const execute = promisify(execFile);
async function capture(args) {
  try {
    return (
      await execute(kubectl, [...prefix, "-n", "cube-system", ...args], {
        cwd: repositoryRoot,
        env,
        maxBuffer: 1024 * 1024,
      })
    ).stdout;
  } catch {
    throw new Error("Cube release discovery failed");
  }
}
// Kubernetes Services remain the discovery authority; no Pod or Docker IP mapping.
for (const name of ["postgres", "session-images", "kafka-1", "kafka-2", "kafka-3"]) {
  const service = JSON.parse(await capture(["get", "service", name, "-o", "json"]));
  if (!service.spec?.selector || !Object.keys(service.spec.selector).length)
    throw new Error(`Cube completion requires a selector-backed ${name} Service`);
}
const release = await prepareCubeRelease({
  repositoryRoot,
  cubeRepository,
  runtimeDirectory,
  validation: { binary: kubectl, prefix, kubeconfig },
});
try {
  const objects = JSON.parse(
    await capture([
      "get",
      "configmap/pi-cloud-posix-volume-plugin",
      "secret/pi-cloud-cube-completion",
      "--ignore-not-found",
      "-o",
      "json",
    ]),
  );
  const adoption = cubeAdoptionFlags(objects.items ?? (objects.kind ? [objects] : []));
  await new Promise((resolvePromise, reject) => {
    const child = spawn(
      process.env.PI_CLOUD_HELM_BIN ?? "helm",
      [
        "upgrade",
        "cube",
        release.chart,
        "--namespace",
        "cube-system",
        "--kubeconfig",
        kubeconfig,
        "--reuse-values",
        ...images,
        ...release.rendererArgs,
        ...adoption,
        "--wait",
        "--timeout",
        "15m",
      ],
      { cwd: repositoryRoot, env, stdio: "inherit" },
    );
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error("Cube release reconciliation failed")),
    );
  });
} finally {
  await release.close();
}
process.stdout.write("Cube release configuration reconciled through Helm\n");
