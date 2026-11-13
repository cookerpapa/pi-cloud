import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { parseAllDocuments } from "yaml";

const render = (version) =>
  parseAllDocuments(
    execFileSync(
      "helm",
      [
        "template",
        "device-link-fixture",
        "deploy/helm/pi-cloud-device-link",
        "--set-string",
        "image=pi-cloud/device-link:fixture",
        "--set-string",
        `global.version=${version}`,
      ],
      { encoding: "utf8" },
    ),
  ).map((document) => document.toJSON());
const resources = render("one"),
  deployment = resources.find((resource) => resource.kind === "Deployment");
assert.equal(deployment.spec.replicas, 1);
assert.deepEqual(
  deployment.spec.template,
  render("two").find((resource) => resource.kind === "Deployment").spec.template,
);
const spec = deployment.spec.template.spec,
  container = spec.containers[0];
assert.equal(spec.automountServiceAccountToken, false);
assert.equal(container.securityContext.readOnlyRootFilesystem, true);
assert.deepEqual(container.securityContext.capabilities.drop, ["ALL"]);
assert.deepEqual(container.env.map((value) => value.name).sort(), [
  "PI_CLOUD_DEVICE_LINK_CREDENTIALS_FILE",
  "PI_CLOUD_SUPERVISOR_MANAGEMENT_TOKEN_FILE",
]);
assert.equal(spec.volumes.find((volume) => volume.name === "management").secret.items.length, 1);
assert.equal(
  spec.volumes.find((volume) => volume.name === "devices").secret.secretName,
  "pi-cloud-device-link-credentials",
);
assert(
  container.volumeMounts.filter((mount) => mount.name !== "tmp").every((mount) => mount.readOnly),
);
assert.equal(resources.find((resource) => resource.kind === "Service").spec.ports[0].port, 8090);
assert.deepEqual(resources.find((resource) => resource.kind === "NetworkPolicy").spec.egress, []);
console.log("device_link_helm_check_passed");
