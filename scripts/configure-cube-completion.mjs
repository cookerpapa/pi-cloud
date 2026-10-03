import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { cubeCompletionPatch, cubeCompletionSecret } from "./lib/cube-execution-deployment.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const runtime = resolve(
  root,
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);
const kubeconfig =
  process.env.PI_CLOUD_CUBE_COMPLETION_KUBECONFIG ?? resolve(runtime, "k3s/kubeconfig.yaml");
const kubectl = process.env.PI_CLOUD_KUBECTL_BIN ?? "/usr/local/bin/k3s";
const prefix = process.env.PI_CLOUD_KUBECTL_BIN ? [] : ["kubectl"];
const env = { ...process.env, KUBECONFIG: kubeconfig };
function capture(command, args) {
  return new Promise((resolvePromise, reject) =>
    execFile(
      command,
      args,
      { cwd: root, env, encoding: "utf8", maxBuffer: 1024 * 1024 },
      (error, stdout) =>
        error ? reject(new Error(`${command} failed`)) : resolvePromise(stdout.trim()),
    ),
  );
}
function apply(value, patch = false) {
  const args = patch
    ? [
        "-n",
        "cube-system",
        "patch",
        "daemonset",
        "cube-node",
        "--type=strategic",
        "--patch",
        JSON.stringify(value),
      ]
    : ["apply", "-f", "-"];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(kubectl, [...prefix, ...args], {
      cwd: root,
      env,
      stdio: [patch ? "ignore" : "pipe", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error("Cube completion configuration failed")),
    );
    if (!patch) child.stdin.end(JSON.stringify(value));
  });
}
// Kubernetes selector-backed Services own discovery. Never publish Pod/Docker IPs.
for (const name of ["postgres", "session-images", "kafka-1", "kafka-2", "kafka-3"]) {
  const service = JSON.parse(
    await capture(kubectl, [...prefix, "-n", "cube-system", "get", "service", name, "-o", "json"]),
  );
  if (!service.spec?.selector || Object.keys(service.spec.selector).length === 0)
    throw new Error(`Cube completion requires a selector-backed ${name} Service`);
}
const files = {};
for (const name of [
  "database-url",
  "supervisor-management-token",
  "session-image-s3-credentials.json",
])
  files[name] = await readFile(resolve(runtime, "secrets", name));
await apply(cubeCompletionSecret(files));
await apply(
  cubeCompletionPatch({
    kafkaBrokers: ["kafka-1:9092", "kafka-2:9092", "kafka-3:9092"],
    controlPlaneUrl: "http://control-plane:3000",
    imageEndpoint: "http://session-images:8333",
    secretDigest: createHash("sha256")
      .update(Buffer.concat(Object.values(files)))
      .digest("hex"),
  }),
  true,
);
await capture(kubectl, [
  ...prefix,
  "-n",
  "cube-system",
  "rollout",
  "status",
  "daemonset/cube-node",
  "--timeout=180s",
]);
process.stdout.write("Cube completion host connections configured\n");
