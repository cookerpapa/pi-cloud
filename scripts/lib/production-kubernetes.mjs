import { execFileSync, spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
export const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);
export const imageCatalogPath = resolve(
  process.env.PI_CLOUD_IMAGE_CATALOG ?? resolve(runtimeDirectory, "k3s/images.json"),
);
export const namespace = "cube-system";
export const kubeconfig =
  process.env.KUBECONFIG ?? resolve(runtimeDirectory, "k3s/kubeconfig.yaml");
const binary = process.env.PI_CLOUD_KUBECTL_BIN ?? "/usr/local/bin/k3s";
const prefix = process.env.PI_CLOUD_KUBECTL_BIN ? [] : ["kubectl"];
export function runtimeEnvironment() {
  return Object.fromEntries(
    readFileSync(resolve(runtimeDirectory, ".env"), "utf8")
      .split(/\r?\n/)
      .filter((line) => line.includes("=") && !line.startsWith("#"))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}
export function kubectl(args, options = {}) {
  return execFileSync(binary, [...prefix, "--kubeconfig", kubeconfig, "-n", namespace, ...args], {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...options,
  });
}
export function kubectlAsync(args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(binary, [...prefix, "--kubeconfig", kubeconfig, "-n", namespace, ...args], {
      cwd: repositoryRoot,
      stdio: "inherit",
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code) =>
      code === 0 ? resolvePromise() : reject(new Error(`kubectl ${args[0]} failed (${code})`)),
    );
  });
}
export const workloads = {
  "control-plane": "deployment/pi-cloud-control-plane",
  web: "deployment/pi-cloud-web",
  "ssh-gateway": "deployment/pi-cloud-ssh-gateway",
  "workspace-volume-gateway": "deployment/pi-cloud-workspace-volume-gateway",
  "pi-workers": "statefulset/pi-cloud-pi-worker-primary-v1",
  postgres: "statefulset/postgres",
  "kafka-1": "statefulset/kafka-1",
  "kafka-2": "statefulset/kafka-2",
  "kafka-3": "statefulset/kafka-3",
  "session-images": "statefulset/session-images",
  "cli-proxy-api": "statefulset/cli-proxy-api",
  "provider-egress-relay": "deployment/provider-bridge-egress-relay",
  "provider-host-egress-relay": "deployment/provider-host-egress-relay",
};
export function workload(name) {
  const value = workloads[name];
  if (value) return value;
  if (/^pi-cloud-pi-worker-primary-v1-\d+$/.test(name)) return `pod/${name}`;
  throw new Error(`Unknown Kubernetes service: ${name}`);
}
export function podFor(service) {
  const target = workload(service);
  if (target.startsWith("pod/")) return target.slice(4);
  const resource = JSON.parse(kubectl(["get", target, "-o", "json"]));
  const selector = Object.entries(resource.spec.selector.matchLabels)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  const pods = JSON.parse(kubectl(["get", "pods", "-l", selector, "-o", "json"])).items;
  const pod = pods.find(
    (p) =>
      !p.metadata.deletionTimestamp &&
      p.status.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
  );
  if (!pod) throw new Error(`No Ready Pod for ${service}`);
  return pod.metadata.name;
}
export function execIn(service, command, options = {}) {
  return kubectl(["exec", "-i", podFor(service), "--", ...command], options);
}
export function runtimeImages() {
  const path = imageCatalogPath;
  if (!existsSync(path)) throw new Error("Run npm run production:build before deployment");
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Host acceptance tools may resolve the stable ClusterIP; runtime Pods use DNS. */
export function serviceAddress(name) {
  if (!workloads[name]) throw new Error("Unknown PiCloud service");
  const serviceName = name === "web" ? "pi-cloud-web" : name;
  return JSON.parse(kubectl(["get", "service", serviceName, "-o", "json"])).spec.clusterIP;
}

/** Explicit fault injection for acceptance; callers must first exclude unrelated active Runs. */
export function signalService(service, signal, prior) {
  if (!new Set(["SIGSTOP", "SIGCONT", "SIGKILL"]).has(signal))
    throw new Error("Unsupported test signal");
  const file =
    service === "control-plane"
      ? "/app/packages/control-plane/src/main.ts"
      : "/app/packages/supervisor-host/src/main.ts";
  if (service !== "control-plane" && !/^pi-cloud-pi-worker-primary-v1-\d+$/.test(service))
    throw new Error("Unknown test process");
  const pod = prior?.pod ?? podFor(service);
  const script = prior
    ? `process.kill(${Number(prior.pid)},${JSON.stringify(signal)})`
    : `const fs=require('fs');const file=${JSON.stringify(file)};const pids=fs.readdirSync('/proc').filter(p=>/^\\d+$/.test(p)&&p!=='1').filter(p=>{try{return fs.readFileSync('/proc/'+p+'/cmdline','utf8').split('\\0').includes(file)}catch(e){if(e.code==='ENOENT')return false;throw e}});if(pids.length!==1)throw Error('Expected one trusted service process');console.log(pids[0]);process.kill(Number(pids[0]),${JSON.stringify(signal)});`;
  const output = kubectl(["exec", pod, "--", "node", "-e", script]).trim();
  return { pod, pid: prior?.pid ?? Number(output) };
}
export async function replacePod(service) {
  await kubectlAsync([
    "delete",
    "pod",
    podFor(service),
    "--grace-period=0",
    "--force",
    "--wait=true",
    "--timeout=120s",
  ]);
  const target = workload(service);
  if (!target.startsWith("pod/"))
    await kubectlAsync(["rollout", "status", target, "--timeout=180s"]);
}
