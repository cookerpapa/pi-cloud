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
assert.equal(webEnvironment.PI_CLOUD_CONTROL_PLANE_UPSTREAM, "pi-cloud-control-plane:3000");
assert.equal(webEnvironment.PI_CLOUD_PREVIEW_UPSTREAM, "pi-cloud-control-plane:3001");
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
assert.equal(customWebEnvironment.PI_CLOUD_CONTROL_PLANE_UPSTREAM, "custom-control-plane:3000");
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
process.stdout.write("Platform Helm chart matches the PostgreSQL/Cube Volume architecture.\n");
