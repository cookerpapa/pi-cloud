import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse, parseAllDocuments } from "yaml";
import { validateDistributedDeploymentValues } from "./distributed-values-policy.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chart = resolve(repositoryRoot, "deploy/helm/pi-cloud-platform");

function fail(message) {
  process.stderr.write(`PiCloud distributed deployment: ${message}\n`);
  process.exit(1);
}

function run(binary, args, options = {}) {
  const result = spawnSync(binary, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: options.inherit ? "inherit" : "pipe",
  });
  if (result.status !== 0) {
    if (!options.inherit) {
      process.stderr.write(result.stderr ?? "");
      process.stderr.write(result.stdout ?? "");
    }
    fail(`${binary} ${args[0] ?? ""} failed`);
  }
  return result.stdout ?? "";
}

function argument(name, fallback) {
  const position = process.argv.indexOf(name);
  if (position < 0) return fallback;
  const value = process.argv[position + 1];
  if (value === undefined || value.startsWith("--")) fail(`${name} requires a value`);
  return value;
}

function requireBinary(binary) {
  run(binary, ["version", binary === "kubectl" ? "--client" : "--short"]);
}

function loadValues(path) {
  if (!existsSync(path)) fail(`values file does not exist: ${path}`);
  const values = parse(readFileSync(path, "utf8"));
  if (values === null || typeof values !== "object" || Array.isArray(values)) {
    fail("values file must contain a YAML mapping");
  }
  return values;
}

function mergeValues(base, override) {
  if (
    base === null ||
    override === null ||
    typeof base !== "object" ||
    typeof override !== "object" ||
    Array.isArray(base) ||
    Array.isArray(override)
  ) {
    return structuredClone(override);
  }
  const merged = structuredClone(base);
  for (const [key, value] of Object.entries(override)) {
    merged[key] = key in merged ? mergeValues(merged[key], value) : structuredClone(value);
  }
  return merged;
}

function namespaceLabels(values) {
  const labels = new Map();
  const policies = [values.networkPolicy];
  if (values.piWorkersEnabled) policies.push(values["pi-workers"].networkPolicy);
  for (const policy of policies.filter((policy) => policy.enabled)) {
    const { key, value } = policy.trustedNamespaceLabel;
    if (labels.has(key) && labels.get(key) !== value) {
      fail(`Network policies disagree on namespace label ${key}`);
    }
    labels.set(key, value);
  }
  return [...labels].map(([key, value]) => `${key}=${value}`);
}

function preflight(namespace, resources) {
  requireBinary("kubectl");
  run("kubectl", ["cluster-info"]);
  // Secrets and the shared PVC must already exist here. An authorization or
  // transport failure must never be mistaken for permission to create it.
  run("kubectl", ["get", "namespace", namespace]);
  const nodes = JSON.parse(run("kubectl", ["get", "nodes", "-o", "json"]));
  const readyNodes = nodes.items.filter(
    (node) =>
      node.spec?.unschedulable !== true &&
      node.status?.conditions?.some(
        (condition) => condition.type === "Ready" && condition.status === "True",
      ),
  );
  if (readyNodes.length < 2 && process.env.PI_CLOUD_ALLOW_SINGLE_NODE_DISTRIBUTED !== "1") {
    fail(
      "at least two Ready schedulable nodes are required; set PI_CLOUD_ALLOW_SINGLE_NODE_DISTRIBUTED=1 only for a non-HA test cluster",
    );
  }
  if (resources.some((resource) => resource.kind === "ScaledObject")) {
    run("kubectl", ["get", "crd", "scaledobjects.keda.sh"]);
    run("kubectl", ["get", "crd", "triggerauthentications.keda.sh"]);
  }
  if (resources.some((resource) => resource.kind === "HorizontalPodAutoscaler")) {
    run("kubectl", ["get", "apiservice", "v1beta1.metrics.k8s.io"]);
  }

  // Use the exact rendered mounts, including projected-key renames and disabled
  // components, instead of maintaining another credential list beside Helm.
  const secrets = new Map();
  const workspaceClaims = new Set();
  const requireSecret = (name, keys = []) => {
    const required = secrets.get(name) ?? new Set();
    for (const key of keys) required.add(key);
    secrets.set(name, required);
  };
  for (const resource of resources) {
    const pod = resource.spec?.template?.spec;
    if (pod) {
      const mounts = pod.containers.flatMap((container) => container.volumeMounts ?? []);
      for (const volume of pod.volumes ?? []) {
        if (volume.secret) {
          const keys = volume.secret.items
            ? volume.secret.items.map((item) => item.key)
            : mounts
                .filter((mount) => mount.name === volume.name && mount.subPath)
                .map((mount) => mount.subPath);
          requireSecret(volume.secret.secretName, keys);
        }
        if (volume.persistentVolumeClaim)
          workspaceClaims.add(volume.persistentVolumeClaim.claimName);
      }
      for (const secret of pod.imagePullSecrets ?? []) requireSecret(secret.name);
    }
    if (resource.kind === "TriggerAuthentication") {
      for (const reference of resource.spec.secretTargetRef)
        requireSecret(reference.name, [reference.key]);
    }
    if (resource.kind === "Ingress") {
      for (const tls of resource.spec.tls ?? [])
        requireSecret(tls.secretName, ["tls.crt", "tls.key"]);
    }
  }
  for (const [name, keys] of secrets) {
    const secret = JSON.parse(
      run("kubectl", ["get", "secret", name, "-n", namespace, "-o", "json"]),
    );
    for (const key of keys) {
      if (!secret.data?.[key]) fail(`Secret ${name} is missing key ${key}`);
    }
  }
  for (const name of workspaceClaims) {
    const claim = JSON.parse(run("kubectl", ["get", "pvc", name, "-n", namespace, "-o", "json"]));
    if (!claim.spec?.accessModes?.includes("ReadWriteMany")) {
      fail(`PVC ${name} must support ReadWriteMany for distributed Volume Gateways`);
    }
  }
  process.stdout.write(
    `Distributed preflight passed: ${readyNodes.length} Ready nodes; rendered Secrets, PVCs and autoscaler dependencies present. External service health is not tested.\n`,
  );
}

const action = process.argv[2] ?? "help";
const namespace = argument("--namespace", "pi-cloud-system");
const release = argument("--release", "pi-cloud");
const configuredValues = argument("--values", "");
const valuesPath = configuredValues === "" ? "" : resolve(process.cwd(), configuredValues);

if (action === "help" || action === "--help" || action === "-h") {
  process.stdout.write(`Usage:
  node scripts/distributed-kubernetes.mjs render --values <file>
  node scripts/distributed-kubernetes.mjs preflight --values <file> [--namespace <name>]
  node scripts/distributed-kubernetes.mjs deploy --values <file> [--namespace <name>] [--release <name>]
  node scripts/distributed-kubernetes.mjs status [--namespace <name>] [--release <name>]
`);
  process.exit(0);
}

if (action === "status") {
  requireBinary("kubectl");
  requireBinary("helm");
  run("helm", ["status", release, "--namespace", namespace], { inherit: true });
  run(
    "kubectl",
    [
      "get",
      "deploy,statefulset,pod,hpa,scaledobject,pvc",
      "--namespace",
      namespace,
      "-l",
      `app.kubernetes.io/instance=${release}`,
      "-o",
      "wide",
    ],
    { inherit: true },
  );
  process.exit(0);
}

if (valuesPath === "") fail("--values <file> is required");
const values = loadValues(valuesPath);
const effectiveValues = mergeValues(loadValues(resolve(chart, "values.yaml")), values);
requireBinary("helm");
run("helm", ["dependency", "build", chart]);
run("helm", ["lint", chart, "--strict", "--values", valuesPath]);

if (action === "render") {
  run("helm", ["template", release, chart, "--namespace", namespace, "--values", valuesPath], {
    inherit: true,
  });
  process.exit(0);
}

if (action !== "preflight" && action !== "deploy") fail(`unknown action: ${action}`);
try {
  validateDistributedDeploymentValues(effectiveValues);
} catch (error) {
  fail(error instanceof Error ? error.message : "distributed values are invalid");
}
const labels = namespaceLabels(effectiveValues);
const resources = parseAllDocuments(
  run("helm", ["template", release, chart, "--namespace", namespace, "--values", valuesPath]),
)
  .map((document) => document.toJSON())
  .filter(Boolean);
preflight(namespace, resources);
if (action === "deploy") {
  if (labels.length) {
    run("kubectl", ["label", "namespace", namespace, ...labels, "--overwrite"], { inherit: true });
  }
  run(
    "helm",
    [
      "upgrade",
      "--install",
      release,
      chart,
      "--namespace",
      namespace,
      "--values",
      valuesPath,
      "--atomic",
      "--wait",
      "--timeout",
      "30m",
    ],
    { inherit: true },
  );
  process.stdout.write(`PiCloud distributed release ${release} is ready.\n`);
}
