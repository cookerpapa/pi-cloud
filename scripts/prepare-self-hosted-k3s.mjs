// Operator-only setup. Never run this program in a Worker or Tool guest.
import {
  mkdirSync,
  statSync,
  chownSync,
  chmodSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { parse, stringify } from "yaml";
import { resolve } from "node:path";
import { runtimeDirectory, runtimeEnvironment } from "./lib/production-kubernetes.mjs";
if (process.getuid() !== 0)
  throw new Error("K3s host storage setup requires the installer/operator's root identity");
const k3sConfigPath = "/etc/rancher/k3s/config.yaml";
const k3sConfig = parse(readFileSync(k3sConfigPath, "utf8"));
const kubeletArgs = k3sConfig["kubelet-arg"] ?? [];
const currentLimit = Number(
  kubeletArgs.find((value) => value.startsWith("pod-max-pids="))?.split("=")[1] ?? 0,
);
if (currentLimit > 0 && currentLimit < 1024) {
  k3sConfig["kubelet-arg"] = [
    ...kubeletArgs.filter((value) => !value.startsWith("pod-max-pids=")),
    "pod-max-pids=1024",
  ];
  writeFileSync(k3sConfigPath, stringify(k3sConfig), { mode: 0o600 });
  execFileSync("systemctl", ["restart", "k3s"], { stdio: "inherit" });
}
const owner = statSync(runtimeDirectory);
if (owner.uid === 0) throw new Error("The runtime directory must belong to the non-root operator");
const e = runtimeEnvironment();
const root = resolve(e.PI_CLOUD_K3S_STORAGE_ROOT ?? "/var/lib/pi-cloud");
if (root === "/" || root.startsWith("/var/lib/docker"))
  throw new Error("Use a dedicated K3s data directory outside Docker storage");
mkdirSync(root, { recursive: true, mode: 0o700 });
for (const name of ["postgres", "kafka-1", "kafka-2", "kafka-3", "session-images"]) {
  const path = resolve(root, name);
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (name !== "postgres") chownSync(path, 1000, 1000);
}
const socket = resolve(runtimeDirectory, "state/provider-relay");
mkdirSync(socket, { recursive: true, mode: 0o700 });
chownSync(socket, 1000, 1000);
const directory = resolve(runtimeDirectory, "k3s");
mkdirSync(directory, { recursive: true, mode: 0o700 });
chownSync(directory, owner.uid, owner.gid);
const config = resolve(directory, "kubeconfig.yaml");
copyFileSync("/etc/rancher/k3s/k3s.yaml", config);
chmodSync(config, 0o600);
chownSync(config, owner.uid, owner.gid);
process.stdout.write("Private K3s operator configuration and retained local storage prepared\n");
