import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments, stringify } from "yaml";
import {
  bridgeTargets,
  composeBridgeResources,
  composeNetworks,
  localWorkerValues,
} from "./local-worker-connections.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chart = resolve(root, "deploy/helm/pi-cloud-pi-worker-pool");
const helm = process.env.PI_CLOUD_HELM_BIN ?? "helm";

function run(arguments_) {
  const result = spawnSync(helm, arguments_, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${arguments_.join(" ")} failed:\n${result.stderr}`);
  return result.stdout;
}

run(["lint", chart, "--strict"]);
const rendered = run([
  "template",
  "pi-workers",
  chart,
  "--namespace",
  "pi-cloud-workers",
  "--set",
  "autoscaling.enabled=true",
]);
assert.doesNotMatch(rendered, /temporal|execution[_-]?cell|checkpoint_s3|aws-credentials/i);

const resources = parseAllDocuments(rendered)
  .map((document) => {
    assert.equal(document.errors.length, 0);
    return document.toJSON();
  })
  .filter(Boolean);
const find = (kind) => resources.find((resource) => resource.kind === kind);
const worker = find("StatefulSet");
assert(worker);
assert.equal(worker.spec.updateStrategy.type, "RollingUpdate");
const environment = Object.fromEntries(
  worker.spec.template.spec.containers[0].env
    .filter((entry) => entry.value !== undefined)
    .map((entry) => [entry.name, String(entry.value)]),
);
assert.equal(environment.DATABASE_URL_FILE, "/run/pi-cloud-secrets/database-url");
assert.equal(
  environment.DATABASE_NOTIFICATION_URL_FILE,
  "/run/pi-cloud-secrets/database-notification-url",
);
assert.equal(environment.PI_CLOUD_SUPERVISOR_CAPACITY, "4");
assert.equal(environment.PI_CLOUD_SUPERVISOR_DATABASE_MAX_CONNECTIONS, "8");
assert.equal(environment.PI_CLOUD_SUBAGENT_MAXIMUM_CONCURRENT, undefined);
assert.equal(environment.PI_CLOUD_WORKER_MODEL_CONCURRENCY, "4");
assert.equal(environment.PI_CLOUD_SESSION_MODEL_CONCURRENCY, "4");

const customWorker = parseAllDocuments(
  run([
    "template",
    "custom-workers",
    chart,
    "--set",
    "database.urlKey=custom-database-url",
    "--set",
    "database.notificationUrlKey=custom-notification-url",
    "--set",
    "credentials.supervisorEnrollmentTokenKey=custom-enrollment",
    "--set",
    "credentials.supervisorManagementTokenKey=custom-management",
    "--set",
    "credentials.toolBrokerTokenKey=custom-broker",
    "--set",
    "credentials.providerGatewayApiKeyKey=custom-provider",
    "--set",
    "credentials.metricsTokenKey=custom-metrics",
  ]),
)
  .map((document) => document.toJSON())
  .find((resource) => resource?.kind === "StatefulSet");
const customPod = customWorker.spec.template.spec;
const secretPaths = new Set(
  customPod.volumes
    .find((volume) => volume.name === "secrets")
    .secret.items.map((item) => item.path),
);
for (const mount of customPod.containers[0].volumeMounts.filter(
  (mount) => mount.name === "secrets",
)) {
  assert(
    secretPaths.has(mount.subPath),
    `Secret mount ${mount.mountPath} refers to missing path ${mount.subPath}`,
  );
}
assert.equal(worker.spec.template.spec.containers[0].imagePullPolicy, "IfNotPresent");

const scaler = find("ScaledObject");
assert(scaler);
assert.equal(scaler.spec.triggers[0].type, "postgresql");
assert.match(scaler.spec.triggers[0].metadata.query, /FROM runs/i);
assert.match(scaler.spec.triggers[0].metadata.query, /pi_session_id/);
assert.match(scaler.spec.triggers[0].metadata.query, /session_leases/);
assert(find("TriggerAuthentication"));
const directory = mkdtempSync(resolve(tmpdir(), "pi-cloud-local-worker-contract-"));
try {
  const values = localWorkerValues(
    {
      PI_CLOUD_KAFKA_PARTITIONS: "64",
      PI_CLOUD_SUPERVISOR_CAPACITY: "8",
      PI_CLOUD_SUPERVISOR_DATABASE_MAX_CONNECTIONS: "6",
      PI_CLOUD_WORKER_MODEL_CONCURRENCY: "12",
      PI_CLOUD_SESSION_MODEL_CONCURRENCY: "6",
      PI_CLOUD_SUBAGENT_MAXIMUM_DEPTH: "3",
      PI_CLOUD_SUBAGENT_MAXIMUM_NODES: "16",
    },
    "pi-cloud-system",
  );
  const path = resolve(directory, "values.yaml");
  writeFileSync(path, stringify(values));
  const local = parseAllDocuments(run(["template", "local-workers", chart, "--values", path]))
    .map((document) => document.toJSON())
    .find((resource) => resource?.kind === "StatefulSet");
  const localEnvironment = Object.fromEntries(
    local.spec.template.spec.containers[0].env.map((entry) => [entry.name, entry.value]),
  );
  for (const [key, value] of Object.entries({
    PI_CLOUD_KAFKA_PARTITIONS: "64",
    PI_CLOUD_SUPERVISOR_CAPACITY: "8",
    PI_CLOUD_SUPERVISOR_DATABASE_MAX_CONNECTIONS: "6",
    PI_CLOUD_WORKER_MODEL_CONCURRENCY: "12",
    PI_CLOUD_SESSION_MODEL_CONCURRENCY: "6",
    PI_CLOUD_SUBAGENT_MAXIMUM_DEPTH: "3",
    PI_CLOUD_SUBAGENT_MAXIMUM_NODES: "16",
  }))
    assert.equal(localEnvironment[key], value);
  const bridges = composeBridgeResources(
    bridgeTargets.map((target) => ({ ...target, address: "192.0.2.10" })),
    "pi-cloud-system",
    "pi-cloud-workers",
  );
  const aliases = bridges.filter(
    (resource) => resource.kind === "Service" && resource.metadata.namespace === "pi-cloud-workers",
  );
  assert.deepEqual(aliases.map((resource) => resource.metadata.name).sort(), [
    "kafka-1",
    "kafka-2",
    "kafka-3",
    "tool-broker",
  ]);
  for (const broker of localEnvironment.PI_CLOUD_KAFKA_BROKERS.split(",")) {
    const [name, port] = broker.split(":");
    assert.equal(port, "9092");
    assert.equal(
      aliases.find((resource) => resource.metadata.name === name).spec.externalName,
      `${name}.pi-cloud-system.svc.cluster.local`,
    );
    assert.equal(
      bridgeTargets.find((target) => target.name === name).network,
      composeNetworks.eventLog,
    );
  }
  const gateway = new URL(localEnvironment.PI_CLOUD_PROVIDER_GATEWAY_URL);
  assert.equal(gateway.hostname, "cli-proxy-api.pi-cloud-system.svc.cluster.local");
  const gatewayBridge = bridges.find(
    (resource) => resource.kind === "Service" && resource.metadata.name === "cli-proxy-api",
  );
  assert.equal(gatewayBridge.spec.ports[0].port, Number(gateway.port));
} finally {
  rmSync(directory, { recursive: true });
}
process.stdout.write("Pi Worker Helm chart uses the shared PostgreSQL queue and passed.\n");
