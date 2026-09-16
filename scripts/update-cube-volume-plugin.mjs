import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Controller-only rollout: updating a storage hook must not restart Cubelets
// or terminate user VMs. Kubernetes ConfigMap subPath mounts need a new Pod.
const plugin = readFileSync(
  new URL("../deploy/cubesandbox/cube-volume-picloud-posix.sh", import.meta.url),
  "utf8",
);
const kubectl = process.env.PI_CLOUD_KUBECTL_BIN ?? "/usr/local/bin/k3s";
const prefix = process.env.PI_CLOUD_KUBECTL_BIN ? [] : ["kubectl"];
const env = { ...process.env, KUBECONFIG: process.env.KUBECONFIG ?? "/etc/rancher/k3s/k3s.yaml" };
const run = (args) =>
  execFileSync(kubectl, [...prefix, "-n", "cube-system", ...args], {
    env,
    stdio: "inherit",
    timeout: 600000,
  });
execFileSync("bash", [
  "-n",
  fileURLToPath(new URL("../deploy/cubesandbox/cube-volume-picloud-posix.sh", import.meta.url)),
]);
// Check the actual Controller image before installing a hook that depends on
// these POSIX publication tools. A local Broker-image test is not this proof.
run([
  "exec",
  "deployment/cube-master",
  "--",
  "bash",
  "-eu",
  "-c",
  "command -v flock sync ln mktemp find od stat realpath; flock --version; sync --version; ln --version",
]);
run([
  "patch",
  "configmap",
  "pi-cloud-posix-volume-plugin",
  "--type=merge",
  "-p",
  JSON.stringify({ data: { "cube-volume-picloud-posix": plugin } }),
]);
run([
  "patch",
  "deployment",
  "cube-master",
  "--type=merge",
  "-p",
  JSON.stringify({
    spec: {
      template: {
        metadata: {
          annotations: {
            "pi-cloud.io/posix-volume-plugin-sha256": createHash("sha256")
              .update(plugin)
              .digest("hex"),
          },
        },
      },
    },
  }),
]);
run(["rollout", "status", "deployment/cube-master", "--timeout=600s"]);
console.log("Cube Controller Volume plugin updated; Cubelets and user VMs were not restarted.");
