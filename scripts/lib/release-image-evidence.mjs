import assert from "node:assert/strict";
import { guestBuildIdentityAtRevision } from "./guest-build-identity.mjs";
import { artifactInputIdentity } from "./release-plan.mjs";

/** Application images belong to this release. A reused guest belongs to its
 * original source commit, which must reproduce the required guest inputs. */
export async function inspectReleaseImage(
  { reference, labelVersion, releaseRevision, repositoryRoot, guestIdentity, artifact },
  capture,
) {
  const values = JSON.parse(await capture("docker", ["image", "inspect", reference]));
  assert.equal(values.length, 1, `Expected one local image for ${reference}`);
  const image = values[0],
    labels = image.Config?.Labels ?? {};
  assert.equal(
    labels["org.opencontainers.image.version"],
    labelVersion,
    `${reference} has the wrong OCI version label`,
  );
  const sourceRevision = labels["org.opencontainers.image.revision"];
  assert.match(sourceRevision ?? "", /^[0-9a-f]{40}$/, `${reference} has no full source revision`);
  if (artifact) {
    assert.equal(artifact.reference, reference, "Artifact reference differs from its plan");
    assert.equal(sourceRevision, artifact.sourceRevision, "Artifact source differs from its plan");
    if (artifact.action === "reuse")
      assert.equal(image.Id, artifact.expectedImageId, "Reused artifact bytes changed");
    else assert.equal(sourceRevision, releaseRevision, "A new build must use current source");
    if (artifact.dockerfile) {
      assert.equal(
        (await artifactInputIdentity(repositoryRoot, sourceRevision, artifact.dockerfile)).identity,
        artifact.inputIdentity,
        "Artifact source inputs changed",
      );
      if (artifact.unchangedSince) {
        const before = await artifactInputIdentity(
          repositoryRoot,
          artifact.unchangedSince,
          artifact.dockerfile,
        );
        const after = await artifactInputIdentity(
          repositoryRoot,
          releaseRevision,
          artifact.dockerfile,
        );
        assert.equal(
          before.identity,
          after.identity,
          "An unaffected artifact acquired changed inputs",
        );
        assert.equal(
          after.identity,
          artifact.unchangedInputIdentity,
          "Unchanged input proof differs from its plan",
        );
      }
    }
  }
  if (guestIdentity !== undefined) {
    assert.match(guestIdentity, /^[0-9a-f]{40}$/);
    assert.equal(
      await guestBuildIdentityAtRevision(repositoryRoot, sourceRevision),
      guestIdentity,
      `${reference} source does not reproduce the required guest build inputs`,
    );
  } else if (!artifact) {
    assert.equal(sourceRevision, releaseRevision, `${reference} has the wrong OCI revision label`);
  }
  assert.match(image.Id, /^sha256:[0-9a-f]{64}$/);
  return {
    reference,
    imageId: image.Id,
    repoDigests: Array.isArray(image.RepoDigests) ? image.RepoDigests.toSorted() : [],
    created: image.Created,
    platform: `${image.Os}/${image.Architecture}`,
    labels: {
      title: labels["org.opencontainers.image.title"],
      version: labels["org.opencontainers.image.version"],
      revision: sourceRevision,
    },
    provenance: {
      releaseRevision,
      sourceRevision,
      ...(artifact
        ? {
            artifactId: artifact.artifactId,
            inputIdentity: artifact.inputIdentity,
            reusedSource: artifact.action === "reuse",
            ...(artifact.unchangedSince
              ? {
                  unchangedSince: artifact.unchangedSince,
                  unchangedInputIdentity: artifact.unchangedInputIdentity,
                }
              : {}),
          }
        : {}),
      ...(guestIdentity === undefined
        ? {}
        : { guestBuildIdentity: guestIdentity, reusedSource: sourceRevision !== releaseRevision }),
    },
  };
}

/** The guest contains language runtimes as well as OS packages; root npm audit cannot cover global npm. */
export function assertGuestInventory(report) {
  const types = new Set((report.Results ?? []).map((result) => result.Type));
  for (const type of ["node-pkg", "python-pkg", "gobinary"])
    assert(types.has(type), `Guest inventory is missing ${type}; do not publish an OS-only scan`);
}
