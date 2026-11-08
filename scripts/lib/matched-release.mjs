import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { guestBuildIdentity, completionBuildIdentity } from "./guest-build-identity.mjs";
import { assertOperatorRevisionChanges } from "./component-release.mjs";

/** A failed control record can retain its Workspace after confirmed compute retirement. */
export function matchedMachineDrained(machine) {
  return (
    ["failed", "reconciling"].includes(machine.state) &&
    machine.allocation_closed === true &&
    machine.allocation_absent === true &&
    machine.runtime_capsule === null &&
    machine.runtime_id === null &&
    machine.runtime_name === null &&
    machine.agent_activation_id === null &&
    machine.terminal_active === false
  );
}

/** Entirely read-only. No Kubernetes/Helm operation belongs in this preflight. */
export async function verifyMatchedRelease({ directory, root, capture, currentGuestTemplate }) {
  const candidate = JSON.parse(await readFile(resolve(directory, "candidate.json"), "utf8"));
  const evidence = JSON.parse(await readFile(resolve(directory, "evidence/manifest.json"), "utf8"));
  assert.equal(candidate.formatVersion, 1, "Unsupported release candidate");
  assert(
    !Object.hasOwn(candidate, "retainedDeploymentDigest"),
    "Obsolete retained-runtime candidate; prepare a full matched release",
  );
  const operatorRevision = (await capture("git", ["rev-parse", "HEAD"])).trim();
  assert.match(candidate.revision, /^[0-9a-f]{40}$/, "Invalid artifact source revision");
  assert.match(operatorRevision, /^[0-9a-f]{40}$/, "Invalid operator source revision");
  if (operatorRevision !== candidate.revision) {
    await capture("git", ["merge-base", "--is-ancestor", candidate.revision, operatorRevision]);
    assertOperatorRevisionChanges(
      (
        await capture("git", [
          "diff",
          "--no-renames",
          "--name-only",
          `${candidate.revision}..${operatorRevision}`,
        ])
      )
        .split("\n")
        .filter(Boolean),
    );
  }
  assert.equal(
    (await capture("git", ["status", "--porcelain", "--untracked-files=all"])).trim(),
    "",
    "Release checkout is dirty",
  );
  assert.equal(candidate.guestIdentity, await guestBuildIdentity(root), "Guest inputs changed");
  assert.equal(
    candidate.completionIdentity,
    await completionBuildIdentity(root),
    "Completion inputs changed",
  );
  assert.equal(evidence.format, "pi-cloud.release-evidence.v1");
  assert.equal(evidence.git.revision, candidate.revision);
  assert.equal(evidence.git.dirty, false);
  assert.equal(evidence.imageVersion, candidate.version);
  assert.equal(
    evidence.images.length,
    14,
    "Matched release requires seven apps, four native images, Cube authorizer/egress and one guest",
  );
  assert.equal(evidence.scope, "all", "Release evidence scope differs from publication");
  const checksums = (await readFile(resolve(directory, "evidence/SHA256SUMS"), "utf8"))
    .trim()
    .split("\n");
  const covered = new Set();
  for (const line of checksums) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9_.\/-]+)$/.exec(line);
    assert(
      match && !match[2].startsWith("/") && !match[2].split("/").includes(".."),
      "Invalid release checksum path",
    );
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(resolve(directory, "evidence", match[2])))
      hash.update(chunk);
    assert.equal(hash.digest("hex"), match[1], "Release evidence changed");
    covered.add(match[2]);
  }
  for (const file of [
    "manifest.json",
    evidence.rootSbom.path,
    evidence.policy.exceptionPolicy.path,
    ...evidence.images.flatMap((image) => [
      image.sbom.path,
      image.vulnerabilityReport.path,
      image.policyVulnerabilityReport.path,
    ]),
  ])
    assert(covered.has(file), "Release evidence is not checksum-covered");
  const references = new Map();
  for (const image of evidence.images) {
    assert(!references.has(image.reference), "Duplicate image evidence");
    const inspected = JSON.parse(await capture("docker", ["image", "inspect", image.reference]));
    assert.equal(inspected.length, 1);
    assert.equal(inspected[0].Id, image.imageId, "Scanned image was replaced");
    assert.equal(
      image.policyVulnerabilities.HIGH.fixable + image.policyVulnerabilities.CRITICAL.fixable,
      0,
      "Release security gate failed",
    );
    references.set(image.reference, image.imageId);
  }
  const catalog = JSON.parse(await readFile(resolve(directory, "images.json"), "utf8"));
  assert.equal(
    Object.keys(catalog).sort().join(","),
    "controlPlane,metering,provider,relay,sessionRuntime,sshGateway,toolHost,volumeGateway,web,worker",
  );
  for (const role of ["sessionRuntime", "metering", "toolHost"])
    assert.equal(
      catalog[role],
      catalog.controlPlane,
      `Matched ${role} must use the scanned shared host artifact`,
    );
  const requiredReferences = new Set([
    ...Object.values(catalog),
    ...[
      "cube-api",
      "cube-master",
      "cube-templatecenter",
      "cubelet",
      "cube-api-authorizer",
      "cube-egress-gateway",
    ].map((name) => `pi-cloud/${name}:${candidate.version}`),
    `localhost:5000/pi-cloud/cubesandbox-tool:${candidate.guestIdentity}`,
  ]);
  // Official chart auxiliaries have their own pinned inventory. They cannot
  // fill a missing custom artifact or compensate for an aliased application.
  assert.equal(requiredReferences.size, 14, "Matched release requires 14 unique custom artifacts");
  for (const reference of requiredReferences)
    assert(references.has(reference), "Unscanned image in release catalog");
  const guest = evidence.images.find(
    (image) =>
      image.reference === `localhost:5000/pi-cloud/cubesandbox-tool:${candidate.guestIdentity}`,
  );
  if (currentGuestTemplate?.imageRevision === candidate.guestIdentity)
    assert(
      guest.repoDigests?.some((ref) => ref.endsWith(`@${currentGuestTemplate.imageDigest}`)),
      "Scanned guest does not match the template selected for reuse",
    );
  return { ...candidate, operatorRevision, guestImageId: guest?.imageId };
}
