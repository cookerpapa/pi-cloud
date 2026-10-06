import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";

import {
  PI_CLOUD_CUBE_TEMPLATE_IMAGE_PREFIX,
  createCubeTemplatePruner,
  parseCubeTemplateRetention,
  selectCubeTemplatesForDeletion,
} from "./cubesandbox-template-retention.mjs";

const id = (suffix) => `tpl-${suffix.padStart(24, "0")}`;
const template = (
  suffix,
  status,
  createdAt,
  imagePrefix = PI_CLOUD_CUBE_TEMPLATE_IMAGE_PREFIX,
) => ({
  template_id: id(suffix),
  status,
  created_at: createdAt,
  image_info: `${imagePrefix}sha256:${suffix.padStart(64, "a")}`,
});

assert.equal(parseCubeTemplateRetention(undefined), 3);
assert.throws(() => parseCubeTemplateRetention("1"), /2 through 10/);
assert.throws(() => parseCubeTemplateRetention("eleven"), /2 through 10/);

const current = id("5");
const selected = selectCubeTemplatesForDeletion({
  inventory: [
    template("1", "READY", "2026-01-01T00:00:00Z"),
    template("2", "FAILED", "2026-01-02T00:00:00Z"),
    template("3", "PENDING", "2026-01-03T00:00:00Z"),
    template("4", "READY", "2026-01-04T00:00:00Z"),
    template("5", "READY", "2026-01-05T00:00:00Z"),
    template("6", "READY", "2026-01-06T00:00:00Z"),
    template("7", "READY", "2026-01-07T00:00:00Z", "registry.example/other@"),
    { template_id: "not-a-template", status: "READY", image_info: "invalid" },
  ],
  protectedTemplateIds: [current],
  retention: 3,
});

assert.deepEqual(
  selected.map((value) => value.template_id),
  [id("1"), id("2")],
  "only superseded terminal PiCloud templates should be selected",
);
assert.ok(
  !selected.some((value) => value.template_id === id("3")),
  "an in-progress template must never be deleted",
);
assert.ok(
  !selected.some((value) => value.template_id === id("7")),
  "another product's Cube template must never be deleted",
);

// Slow successes share one budget across release phases; a timeout/failure
// must not start a separate wait for every remaining historical replica.
let clock = 0;
const calls = [];
const prune = createCubeTemplatePruner({
  now: () => clock,
  budgetMs: 30,
  deleteTemplate: async (templateId, timeoutMs) => {
    calls.push({ templateId, timeoutMs });
    clock += 15;
  },
});
assert.equal((await prune(selected.slice(0, 1))).deleted, 1);
clock += 60_000; // Image construction time does not consume cleanup's I/O budget.
const exhausted = await prune(selected);
assert.equal(exhausted.deleted, 1);
assert.equal(exhausted.deferred, 1);
assert.equal(exhausted.stopReason, "budget_exhausted");
assert.deepEqual(
  calls.map((call) => call.timeoutMs),
  [30, 15],
);
assert.equal((await prune(selected)).deferred, selected.length);
assert.equal(calls.length, 2);

let attempts = 0;
const failedPrune = createCubeTemplatePruner({
  deleteTemplate: async () => {
    attempts += 1;
    throw new Error("replica deletion timed out");
  },
});
const failed = await failedPrune(selected);
assert.equal(failed.deleted, 0);
assert.equal(failed.deferred, selected.length);
assert.equal(failed.failure.templateId, selected[0].template_id);
assert.equal(failed.stopReason, "delete_unconfirmed");
await failedPrune(selected);
assert.equal(attempts, 1, "later registration phases must not repeat failed cleanup");

const cubeValuesDocument = parseDocument(
  readFileSync("deploy/cubesandbox/values-pi-cloud-single-node.yaml", "utf8"),
);
assert.equal(cubeValuesDocument.errors.length, 0, "Cube values must be valid YAML");
assert.equal(
  cubeValuesDocument.toJSON()?.bootstrap?.nodeInit?.dataCubelet?.loopback?.size,
  "64G",
  "the local Cubelet data image must retain its bounded production-check capacity",
);
const installer = readFileSync("scripts/install-cubesandbox-k3s.mjs", "utf8");
const releaseEvidence = readFileSync("scripts/generate-release-evidence.mjs", "utf8");
assert.ok(
  /reference: `pi-cloud\/\$\{imageName\}:\$\{options.imageVersion\}`/u.test(releaseEvidence),
  "Release evidence must inspect the selected matched image version",
);
assert.match(releaseEvidence, /await guestBuildIdentity\(repositoryRoot\)/u);
assert.match(releaseEvidence, /"cli-proxy-api"/u);
const cubeBuilder = readFileSync("scripts/build-cubesandbox-runtime.mjs", "utf8");
assert.match(cubeBuilder, /org.opencontainers.image.revision=\$\{revision\}/u);
assert.equal(cubeBuilder.match(/\.\.\.imageLabels/g)?.length, 2);
assert.ok(
  !/reference: `pi-cloud\/\$\{imageName\}:local`/u.test(releaseEvidence),
  "Retired mutable Cube image tags must not remain",
);
assert.match(installer, /ensureCubeletLoopbackCapacity\(\)/u);
assert.match(installer, /xfs_growfs/u);
assert.match(installer, /PI_CLOUD_KUBECTL_BIN/u);
assert.match(installer, /\$\{authorizerImageRepository\}:\$\{piCloudRevision\}/u);
assert.match(installer, /\$\{cubeEgressGatewayImageRepository\}:\$\{piCloudRevision\}/u);
assert.match(installer, /set[\s\S]+image[\s\S]+authorizer=/u);
assert.match(installer, /set[\s\S]+image[\s\S]+gateway=/u);
assert.match(installer, /images[\s\S]+import[\s\S]+archivePath/u);
// Final mounts and consumer fingerprints are validated on rendered manifests
// by cube-release-render.test.mjs and the deployment preflight. The installer
// must use that path, not duplicate mounts in post-install imperative patches.
assert.match(installer, /prepareCubeRelease/u);
assert.match(installer, /cubeRelease\.rendererArgs/u);
const renderer = readFileSync("scripts/lib/cube-release-render.mjs", "utf8");
assert.match(
  renderer,
  /pi-cloud\.io\/posix-shared-root-identity/u,
  "the rendered Cube release must roll Pods when the hostPath inode changes",
);
assert.ok(
  !installer.includes('capture("kubectl"') && !installer.includes('run("kubectl"'),
  "the Cube installer must not select a host kubectl through an uncontrolled PATH",
);

process.stdout.write("cubesandbox_template_retention_check_passed\n");
