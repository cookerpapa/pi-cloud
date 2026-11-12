import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parseAllDocuments } from "yaml";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const digest = /^sha256:[0-9a-f]{64}$/;
const workloadKinds = new Set([
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "ReplicaSet",
  "ReplicationController",
  "Job",
]);

export function canonicalImageReference(value) {
  assert(
    typeof value === "string" &&
      value.length > 0 &&
      value.length <= 512 &&
      !/[\s\u0000-\u001f]/.test(value) &&
      !value.includes("://"),
    "Invalid rendered image reference",
  );
  const parts = value.split("@");
  assert(
    parts.length <= 2 && (parts.length === 1 || digest.test(parts[1])),
    "Invalid rendered image digest",
  );
  const [name, hash] = parts,
    segments = name.split("/");
  assert(
    segments.every((part) => part && part !== "." && part !== "..") &&
      /^[A-Za-z0-9_./:-]+$/.test(name),
    "Invalid rendered image repository",
  );
  const qualified =
    segments.length === 1
      ? `docker.io/library/${name}`
      : !segments[0].includes(".") && !segments[0].includes(":") && segments[0] !== "localhost"
        ? `docker.io/${name}`
        : name;
  return hash ? `${qualified}@${hash}` : qualified;
}

function imageParts(value) {
  const canonical = canonicalImageReference(value),
    [name, hash] = canonical.split("@");
  const slash = name.lastIndexOf("/"),
    colon = name.lastIndexOf(":");
  const repository = colon > slash ? name.slice(0, colon) : name;
  return {
    canonical,
    repository,
    tag: colon > slash ? name.slice(colon + 1) : null,
    digest: hash ?? null,
  };
}

function customImage(value) {
  return imageParts(value).repository.split("/").slice(1).includes("pi-cloud");
}

export function cubeUpstreamImageClosure(manifest, runtimeBuild) {
  assert(
    typeof manifest === "string" && Buffer.byteLength(manifest) <= 20 * 1024 ** 2,
    "Cube candidate manifest exceeds its bound",
  );
  const version = runtimeBuild?.upstreamVersion;
  assert(
    typeof version === "string" && /^\d+\.\d+\.\d+$/.test(version),
    "Missing pinned Cube upstream version",
  );
  let documents;
  try {
    documents = parseAllDocuments(manifest, { prettyErrors: false, logLevel: "silent" })
      .map((document) => {
        if (document.errors.length) throw new Error();
        return document.toJS({ maxAliasCount: 100 });
      })
      .filter(Boolean);
  } catch {
    throw new Error("Invalid private Cube candidate manifest YAML");
  }
  const references = new Set();
  let pods = 0;
  const visit = (resource) => {
    assert(
      resource && typeof resource === "object" && !Array.isArray(resource),
      "Invalid Cube manifest resource",
    );
    if (resource.kind === "List") {
      assert(Array.isArray(resource.items), "Invalid manifest resource list");
      for (const item of resource.items) visit(item);
      return;
    }
    const pod =
      resource.kind === "Pod"
        ? resource.spec
        : resource.kind === "CronJob"
          ? resource.spec?.jobTemplate?.spec?.template?.spec
          : workloadKinds.has(resource.kind)
            ? resource.spec?.template?.spec
            : undefined;
    if (!pod) {
      assert(!resource.spec?.template?.spec?.containers, "Unrecognized rendered workload kind");
      return;
    }
    pods++;
    assert(
      Array.isArray(pod.containers) && pod.containers.length > 0,
      "Rendered workload has no containers",
    );
    for (const key of ["containers", "initContainers", "ephemeralContainers"]) {
      const containers = pod[key] ?? [];
      assert(Array.isArray(containers), "Invalid rendered container list");
      for (const container of containers) {
        const reference = container?.image,
          parts = imageParts(reference);
        const base = parts.repository.split("/").at(-1);
        assert(
          container.name !== "network-agent" && base !== "network-agent",
          "Legacy network-agent is outside the maintained Cube release",
        );
        assert(
          !parts.repository.split("/").includes("minio") && !/^minio(?:-|$)/.test(base),
          "MinIO is disabled in the maintained Cube chart",
        );
        assert(
          !parts.repository.includes("s3lvol"),
          "S3lvol is disabled in the maintained Cube chart",
        );
        if (customImage(reference)) continue;
        if (/^(?:cube-|cubelet$|cubemastercli$)/.test(base))
          assert.equal(
            parts.tag,
            `v${version}`,
            "Rendered Cube image differs from the pinned upstream release",
          );
        references.add(reference);
      }
    }
  };
  for (const document of documents) visit(document);
  assert(
    pods > 0 && references.size > 0 && references.size <= 256,
    "Cube upstream image closure is empty or exceeds its bound",
  );
  return {
    upstreamVersion: version,
    manifestSha256: sha256(manifest),
    references: [...references].sort(),
  };
}

export function inspectCubeUpstreamImage(reference, inspected) {
  const source = imageParts(reference);
  assert(inspected && digest.test(inspected.Id), "Missing local upstream image identity");
  assert(
    inspected.Os === "linux" && inspected.Architecture === "amd64",
    "Upstream image has the wrong maintained platform",
  );
  assert(
    Array.isArray(inspected.RepoDigests) &&
      inspected.RepoDigests.length > 0 &&
      inspected.RepoDigests.length <= 256,
    "Upstream image has no immutable registry digest",
  );
  const repoDigests = [...new Set(inspected.RepoDigests.map(canonicalImageReference))].sort();
  const candidates = repoDigests.filter((value) => {
    const item = imageParts(value);
    return (
      item.repository === source.repository &&
      item.digest !== null &&
      (source.digest === null || item.digest === source.digest)
    );
  });
  const descriptor = inspected.Descriptor?.digest;
  const selected =
    descriptor && candidates.includes(`${source.repository}@${descriptor}`)
      ? `${source.repository}@${descriptor}`
      : candidates.length === 1
        ? candidates[0]
        : undefined;
  assert(selected, "Upstream image registry digest is missing or ambiguous");
  return { reference, imageId: inspected.Id, repoDigests, pinnedReference: selected };
}

export function createCubeUpstreamEvidence(manifest, runtimeBuild, inspected) {
  const closure = cubeUpstreamImageClosure(manifest, runtimeBuild);
  const images = closure.references.map((reference) =>
    inspectCubeUpstreamImage(reference, inspected.get(reference)),
  );
  return {
    formatVersion: 1,
    upstreamVersion: closure.upstreamVersion,
    manifestSha256: closure.manifestSha256,
    images,
  };
}

/** Preparation pins already verified local bytes; only a confirmed cache miss
 * needs the registry. An inspection failure or invalid local image is fatal. */
export async function prepareCubeUpstreamImages(references, { inspect, pull }) {
  const images = new Map();
  for (const reference of references) {
    let value = await inspect(reference);
    if (value === null) {
      await pull(reference);
      value = await inspect(reference);
    }
    inspectCubeUpstreamImage(reference, value);
    images.set(reference, value);
  }
  return images;
}

export function verifyCubeUpstreamEvidence(manifest, runtimeBuild, evidence, inspected) {
  const closure = cubeUpstreamImageClosure(manifest, runtimeBuild);
  assert(
    evidence?.formatVersion === 1 &&
      evidence.upstreamVersion === closure.upstreamVersion &&
      evidence.manifestSha256 === closure.manifestSha256,
    "Cube manifest or upstream pin changed after image preparation",
  );
  assert(Array.isArray(evidence.images), "Missing upstream image evidence");
  assert.deepEqual(
    evidence.images.map((row) => row.reference).sort(),
    closure.references,
    "Prepared upstream image closure differs from the rendered candidate",
  );
  for (const row of evidence.images) {
    assert(
      digest.test(row.imageId) && Array.isArray(row.repoDigests) && row.repoDigests.length > 0,
      "Invalid upstream image evidence",
    );
    const pinned = imageParts(row.pinnedReference),
      source = imageParts(row.reference);
    assert(
      pinned.digest &&
        pinned.tag === null &&
        pinned.repository === source.repository &&
        row.repoDigests.map(canonicalImageReference).includes(row.pinnedReference) &&
        (!source.digest || source.digest === pinned.digest),
      "Upstream digest evidence changed",
    );
    const local = inspected.get(row.reference);
    assert(
      local && local.Id === row.imageId && local.Os === "linux" && local.Architecture === "amd64",
      "Prepared upstream image is missing or changed locally",
    );
    assert(
      Array.isArray(local.RepoDigests) &&
        local.RepoDigests.map(canonicalImageReference).includes(row.pinnedReference),
      "Prepared registry digest is no longer available locally",
    );
  }
  return evidence.images;
}

export function assertUpstreamArchiveClosure(listing, images) {
  const entries = new Set(listing.split(/\r?\n/).map((name) => name.replace(/^\.\//, "")));
  for (const image of images) {
    const hash = imageParts(image.pinnedReference).digest;
    assert(
      entries.has(`blobs/sha256/${hash.slice(7)}`),
      "Docker export did not preserve a prepared registry manifest digest",
    );
  }
}

export function missingImportedUpstreamImages(listing, images) {
  const entries = new Map(
    listing
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [name, , target] = line.trim().split(/\s+/);
        return [name, target];
      }),
  );
  for (const image of images) {
    if (!entries.has(image.pinnedReference)) continue;
    assert.equal(
      entries.get(image.pinnedReference),
      imageParts(image.pinnedReference).digest,
      "K3s did not confirm the prepared upstream image digest",
    );
  }
  return images.filter((image) => !entries.has(image.pinnedReference));
}

export function assertImportedUpstreamImages(listing, images) {
  assert.equal(
    missingImportedUpstreamImages(listing, images).length,
    0,
    "K3s did not confirm the prepared upstream image digest",
  );
}
