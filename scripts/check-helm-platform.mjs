import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments } from "yaml";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const chart = resolve(root, "deploy/helm/pi-cloud-platform");
const helm = process.env.PI_CLOUD_HELM_BIN ?? "helm";
function run(arguments_) {
  const result = spawnSync(helm, arguments_, { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 0, `${arguments_.join(" ")} failed:\n${result.stderr}`);
  return result.stdout;
}

run(["dependency", "build", chart]);
run(["lint", chart, "--strict"]);
const rendered = run(["template", "pi-cloud", chart, "--namespace", "pi-cloud-system"]);
assert.doesNotMatch(
  rendered,
  /temporal|execution[_-]?cell|kopia|minio|checkpoint_s3|aws-credentials/i,
);
const resources = parseAllDocuments(rendered)
  .map((document) => {
    assert.equal(document.errors.length, 0);
    return document.toJSON();
  })
  .filter(Boolean);
const find = (kind, name) =>
  resources.find((resource) => resource.kind === kind && resource.metadata?.name === name);
const controlPlane = find("Deployment", "pi-cloud-control-plane");
assert(controlPlane);
const environment = Object.fromEntries(
  controlPlane.spec.template.spec.containers[0].env
    .filter((entry) => entry.value !== undefined)
    .map((entry) => [entry.name, String(entry.value)]),
);
assert.equal(
  controlPlane.spec.template.spec.containers[0].env.some(
    (entry) => entry.name === "PI_CLOUD_DATABASE_NOTIFICATION_URL_FILE",
  ),
  false,
);
assert.equal(
  controlPlane.spec.template.spec.containers[0].volumeMounts.some(
    (mount) => mount.mountPath === "/run/pi-cloud-secrets/database-notification-url",
  ),
  false,
);
assert.match(environment.PI_CLOUD_SUPERVISOR_MANAGEMENT_URL_TEMPLATES, /\{supervisorId\}/);
assert(find("StatefulSet", "pi-cloud-pi-worker-primary-v1"));
assert(find("Deployment", "pi-cloud-workspace-volume-gateway"));
const web = find("Deployment", "pi-cloud-web");
assert(web);
const webEnvironment = Object.fromEntries(
  web.spec.template.spec.containers[0].env?.map((entry) => [entry.name, entry.value]) ?? [],
);
assert.equal(webEnvironment.PI_CLOUD_CONTROL_PLANE_UPSTREAM, "control-plane:3000");
assert.equal(webEnvironment.PI_CLOUD_PREVIEW_UPSTREAM, "control-plane:3001");
assert.equal(
  webEnvironment.PI_CLOUD_PUBLIC_ORIGIN_BASE_URL,
  environment.PI_CLOUD_PUBLIC_ORIGIN_BASE_URL,
);
assert.equal(webEnvironment.PI_CLOUD_ADMIN_ORIGIN_BASE_URL, "https://admin.pi-cloud.example.com");
assert.equal(webEnvironment.PI_CLOUD_GRAFANA_URL, "");
assert(
  find("Service", "pi-cloud-web").spec.ports.some(
    (port) => port.name === "admin" && port.port === 8081,
  ),
);
const customIngress = parseAllDocuments(
  run([
    "template",
    "custom",
    chart,
    "--set",
    "web.ingress.enabled=true",
    "--set",
    "web.ingress.host=chat.company.test",
    "--set",
    "web.ingress.adminHost=ops.company.test",
    "--set",
    "controlPlane.publicOriginBaseUrl=https://chat.company.test",
    "--set",
    "web.adminOriginBaseUrl=https://ops.company.test",
    "--set",
    "web.ingress.tlsSecretName=company-web-tls",
    "--set",
    "web.managementUrls.grafana=https://metrics.company.test/grafana/",
  ]),
)
  .map((document) => document.toJSON())
  .filter(Boolean);
const ingress = customIngress.find((resource) => resource.kind === "Ingress");
assert.equal(
  ingress.spec.rules.find((rule) => rule.host === "ops.company.test").http.paths[0].backend.service
    .port.number,
  8081,
);
assert(ingress.spec.tls[0].hosts.includes("ops.company.test"));
const customWeb = customIngress.find(
  (resource) => resource.kind === "Deployment" && resource.metadata.name === "custom-web",
);
assert(customWeb);
const customWebEnvironment = Object.fromEntries(
  customWeb.spec.template.spec.containers[0].env.map((entry) => [entry.name, entry.value]),
);
assert.equal(customWebEnvironment.PI_CLOUD_CONTROL_PLANE_UPSTREAM, "control-plane:3000");
assert.equal(customWebEnvironment.PI_CLOUD_ADMIN_ORIGIN_BASE_URL, "https://ops.company.test");
assert.equal(customWebEnvironment.PI_CLOUD_GRAFANA_URL, "https://metrics.company.test/grafana/");
const customDatabaseKeys = parseAllDocuments(
  run([
    "template",
    "pi-cloud",
    chart,
    "--namespace",
    "pi-cloud-system",
    "--set",
    "external.database.secretKey=pooled-database",
    "--set",
    "external.database.notificationSecretKey=direct-database",
  ]),
)
  .map((document) => document.toJSON())
  .filter(Boolean);
for (const [kind, name, key] of [
  ["Deployment", "pi-cloud-control-plane", "pooled-database"],
  ["StatefulSet", "pi-cloud-tool-broker", "pooled-database"],
  ["Deployment", "pi-cloud-workspace-volume-gateway", "direct-database"],
]) {
  const workload = customDatabaseKeys.find(
    (resource) => resource.kind === kind && resource.metadata.name === name,
  );
  assert.equal(
    workload.spec.template.spec.containers[0].volumeMounts.find(
      (mount) => mount.mountPath === "/run/pi-cloud-secrets/database-url",
    ).subPath,
    key,
  );
}

// Rendering syntactically valid YAML is insufficient: check the interfaces
// between workloads, Services, network policies and projected Secret files.
const contractFailures = [];
function contract(name, check) {
  try {
    check();
  } catch (error) {
    contractFailures.push(new Error(name, { cause: error }));
  }
}
for (const [name, target] of Object.entries(webEnvironment).filter(
  ([key]) => key === "PI_CLOUD_CONTROL_PLANE_UPSTREAM" || key === "PI_CLOUD_PREVIEW_UPSTREAM",
)) {
  contract(`Web ${name} must resolve to a rendered Service`, () => {
    const [host, port] = target.split(":");
    const service = find("Service", host);
    assert(service, `Missing Service ${host}`);
    assert(service.spec.ports.some((candidate) => candidate.port === Number(port)));
  });
}
const allows = (policy, port, peer) =>
  policy.spec.egress.some(
    (rule) =>
      rule.to?.some(peer) &&
      rule.ports?.some((candidate) => candidate.protocol === "TCP" && candidate.port === port),
  );
const trusted = (peer) =>
  peer.namespaceSelector?.matchLabels?.["pi-cloud.io/trusted-plane"] === "true";
for (const [name, port] of [
  ["pi-cloud-control-plane", 9092],
  ["pi-cloud-tool-broker", 4500],
  ["pi-cloud-pi-worker-primary-v1", 9092],
]) {
  contract(`${name} egress must admit its dependency on port ${port}`, () =>
    assert(allows(find("NetworkPolicy", name), port, trusted)),
  );
}
const externalResources = parseAllDocuments(
  run([
    "template",
    "pi-cloud",
    chart,
    "--values",
    resolve(chart, "values.distributed.example.yaml"),
  ]),
)
  .map((document) => document.toJSON())
  .filter(Boolean);
for (const port of [5432, 4300]) {
  contract(`SSH Gateway external egress must allow port ${port}`, () =>
    assert(
      allows(
        externalResources.find(
          (resource) =>
            resource.kind === "NetworkPolicy" && resource.metadata.name === "pi-cloud-ssh-gateway",
        ),
        port,
        (peer) => peer.ipBlock?.cidr === "203.0.113.16/28",
      ),
    ),
  );
}
contract("Distributed example Worker must reach Kafka", () =>
  assert(
    allows(
      externalResources.find(
        (resource) =>
          resource.kind === "NetworkPolicy" &&
          resource.metadata.name === "pi-cloud-pi-worker-primary-v1",
      ),
      9092,
      (peer) => peer.ipBlock?.cidr === "203.0.113.16/28",
    ),
  ),
);
for (const name of ["pi-cloud-database-bootstrap"]) {
  contract(`${name} non-root process must read its private Secrets`, () => {
    const pod = resources.find(
      (resource) =>
        resource.metadata?.name === name && ["Job", "Deployment"].includes(resource.kind),
    ).spec.template.spec;
    assert.equal(pod.securityContext.fsGroup, pod.securityContext.runAsGroup);
  });
}
if (contractFailures.length)
  throw new AggregateError(contractFailures, "Helm cross-component contracts failed");
process.stdout.write("Platform Helm chart matches the PostgreSQL/Cube Volume architecture.\n");
