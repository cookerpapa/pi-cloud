import assert from "node:assert/strict";
import { guestBuildIdentityAtRevision } from "./guest-build-identity.mjs";

/** Application images belong to this release. A reused guest belongs to its
 * original source commit, which must reproduce the required guest inputs. */
export async function inspectReleaseImage(
  { reference, labelVersion, releaseRevision, repositoryRoot, guestIdentity },
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
  if (guestIdentity !== undefined) {
    assert.match(guestIdentity, /^[0-9a-f]{40}$/);
    assert.equal(
      await guestBuildIdentityAtRevision(repositoryRoot, sourceRevision),
      guestIdentity,
      `${reference} source does not reproduce the required guest build inputs`,
    );
  } else {
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
      ...(guestIdentity === undefined
        ? {}
        : { guestBuildIdentity: guestIdentity, reusedSource: sourceRevision !== releaseRevision }),
    },
  };
}
