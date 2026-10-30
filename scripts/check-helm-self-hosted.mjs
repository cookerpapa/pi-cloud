import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify, parseAllDocuments } from "yaml";
import { selfHostedValues } from "./lib/self-hosted-values.mjs";
const id = "00000000-0000-4000-8000-000000000001";
const environment = Object.fromEntries(
  [
    "TENANT_ID",
    "PLATFORM_MODEL_SOURCE_TENANT_ID",
    "PLATFORM_OPERATOR_TENANT_ID",
    "USER_ID",
    "API_CREDENTIAL_ID",
    "CREDENTIAL_BINDING_ID",
    "DEFAULT_MODEL_PROFILE_ID",
  ].map((k) => [`PI_CLOUD_${k}`, id]),
);
const images = Object.fromEntries(
  ["controlPlane", "worker", "web", "volumeGateway", "sshGateway", "relay", "provider"].map(
    (key) => [key, `pi-cloud/${key.toLowerCase()}:fixture`],
  ),
);
const template = {
  imageRevision: "a".repeat(40),
  agent: { templateId: "tpl-" + "a".repeat(24) },
  development: Object.fromEntries(
    ["starter", "standard", "performance"].map((k) => [k, { templateId: "tpl-" + "b".repeat(24) }]),
  ),
};
const values = selfHostedValues({
  environment,
  runtime: "/var/lib/private-picloud",
  cluster: { nodeName: "fixture-node", sandboxDomain: "cube.app" },
  template,
  images,
});
const directory = mkdtempSync(join(tmpdir(), "pi-cloud-k3s-contract-"));
try {
  const objects = [];
  for (const key of ["infrastructure", "platform"]) {
    const path = join(directory, key + ".yaml");
    writeFileSync(path, stringify(values[key]));
    const rendered = execFileSync(
      process.env.PI_CLOUD_HELM_BIN ?? "helm",
      [
        "template",
        key === "platform" ? "pi-cloud" : "pi-cloud-infrastructure",
        `deploy/helm/pi-cloud-${key}`,
        "-n",
        "cube-system",
        "-f",
        path,
      ],
      { encoding: "utf8" },
    );
    objects.push(
      ...parseAllDocuments(rendered)
        .map((document) => {
          assert.equal(document.errors.length, 0);
          return document.toJSON();
        })
        .filter(Boolean),
    );
  }
  const find = (kind, name) => {
    const o = objects.find((o) => o.kind === kind && o.metadata.name === name);
    assert(o, `${kind}/${name}`);
    return o;
  };
  for (const name of [
    "postgres",
    "kafka-1",
    "kafka-2",
    "kafka-3",
    "session-images",
    "control-plane",
  ])
    assert(Object.keys(find("Service", name).spec.selector).length > 0);
  assert.equal(objects.filter((o) => o.kind === "EndpointSlice").length, 0);
  for (const pv of objects.filter((o) => o.kind === "PersistentVolume")) {
    assert.equal(pv.spec.persistentVolumeReclaimPolicy, "Retain");
    assert(pv.spec.nodeAffinity);
    assert(!pv.spec.local.path.startsWith("/var/lib/docker"));
    assert.equal(pv.metadata.annotations["helm.sh/resource-policy"], "keep");
  }
  const web = find("Deployment", "pi-cloud-web");
  assert.equal(web.spec.strategy.type, "Recreate");
  assert.deepEqual(
    web.spec.template.spec.containers[0].ports.map((p) => p.hostPort).sort((a, b) => a - b),
    [8080, 8081, 8318],
  );
  for (const p of web.spec.template.spec.containers[0].ports) assert.equal(p.hostIP, "127.0.0.1");
  assert.equal(
    find("Deployment", "provider-host-egress-relay").spec.template.spec.hostNetwork,
    true,
  );
  assert.equal(
    find("Deployment", "provider-bridge-egress-relay").spec.template.spec.hostNetwork,
    false,
  );
  const worker = find("StatefulSet", "pi-cloud-pi-worker-primary-v1");
  assert.equal(worker.spec.replicas, 2);
  assert.equal(worker.spec.template.spec.hostNetwork, false);
  const gateway = find("StatefulSet", "cli-proxy-api").spec.template.spec.containers[0];
  const providerEnv = Object.fromEntries(gateway.env.map((e) => [e.name, e.value]));
  assert.equal(providerEnv.PI_CLOUD_MODEL_REQUEST_MAX_BYTES, "268435456");
  assert.equal(providerEnv.PI_CLOUD_MODEL_UPLOAD_MAX_BYTES, "536870912");
  assert.equal(gateway.resources.limits, undefined);
  assert.equal(
    gateway.env.some((e) => e.name === "GOMEMLIMIT"),
    false,
  );
  for (const resource of objects.filter((o) =>
    ["Deployment", "StatefulSet", "Job"].includes(o.kind),
  )) {
    for (const container of resource.spec.template.spec.containers)
      assert.equal(
        container.resources?.limits,
        undefined,
        `${resource.metadata.name} must not impose a hard resource quota`,
      );
  }
  const cp = find("Deployment", "pi-cloud-control-plane");
  const env = Object.fromEntries(
    cp.spec.template.spec.containers[0].env.map((x) => [x.name, x.value]),
  );
  assert.equal(env.PI_CLOUD_CUBESANDBOX_API_URL, "http://cube-api:3000");
  assert.equal(env.PI_CLOUD_WEB_SESSION_COOKIE_SECURE, "false");
  assert.equal(env.PI_CLOUD_PREVIEW_ORIGIN_BASE_URL, "http://preview.localhost:8080");
  assert.equal(cp.spec.replicas, 1);
  const negative = execFileSync;
  assert.throws(
    () =>
      negative(
        "helm",
        [
          "template",
          "invalid",
          "deploy/helm/pi-cloud-platform",
          "--set",
          "controlPlane.replicas=1",
        ],
        { stdio: "pipe" },
      ),
    /Command failed/,
  );
  assert(
    !readFileSync("scripts/configure-cube-completion.mjs", "utf8").includes('capture("docker"'),
  );
  console.log(
    "Self-hosted K3s charts: native discovery, local storage retention, entry points and trusted boundaries passed.",
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
