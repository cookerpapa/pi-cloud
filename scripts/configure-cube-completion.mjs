import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  cubeCompletionBridge,
  cubeCompletionPatch,
  cubeCompletionSecret,
} from "./lib/cube-execution-deployment.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const runtime = resolve(
  root,
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);
const kubeconfig =
  process.env.PI_CLOUD_CUBE_COMPLETION_KUBECONFIG ??
  resolve(runtime, "cubesandbox/completion-kubeconfig.json");
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
        "--patch-file=/dev/stdin",
      ]
    : ["apply", "-f", "-"];
  return new Promise((resolvePromise, reject) => {
    const child = spawn(kubectl, [...prefix, ...args], {
      cwd: root,
      env,
      stdio: ["pipe", "inherit", "inherit"],
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error("Cube completion configuration failed")),
    );
    child.stdin.end(JSON.stringify(value));
  });
}
const targets = [];
for (const [name, network, port, required] of [
  ["postgres", "database", 5432, true],
  ["session-images", "database", 8333, true],
  ["control-plane", "management", 3000, false],
  ...[1, 2, 3].map((id) => [`kafka-${id}`, "event-log", 9092, true]),
]) {
  const id = await capture("docker", [
    "ps",
    "-q",
    "--filter",
    "label=com.docker.compose.project=pi-cloud-production",
    "--filter",
    `label=com.docker.compose.service=${name}`,
  ]);
  if (!id) {
    if (required) throw new Error(`Start ${name} before configuring Cube completion`);
    continue;
  }
  const [container] = JSON.parse(await capture("docker", ["inspect", id]));
  const address = container.NetworkSettings.Networks[`pi-cloud-production_${network}`]?.IPAddress;
  if (!address) throw new Error(`Missing trusted ${name} network address`);
  targets.push({ name, address, port });
}
for (const object of cubeCompletionBridge(targets)) await apply(object);
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
