import { expect, it } from "vitest";
import { stringify } from "yaml";
import {
  canonicalImageReference,
  cubeUpstreamImageClosure,
  inspectCubeUpstreamImage,
  createCubeUpstreamEvidence,
  verifyCubeUpstreamEvidence,
  assertUpstreamArchiveClosure,
  assertImportedUpstreamImages,
} from "./cube-upstream-images.mjs";

const runtimeBuild = { upstreamVersion: "0.7.3" };
const cubeImage = "cube-sandbox-int.tencentcloudcr.com/cube-sandbox/cube-shim:v0.7.3";
const sha = (character) => `sha256:${character.repeat(64)}`;
function manifest(extra = []) {
  return [
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "private-config" },
      stringData: { password: "VERY_PRIVATE_FIXTURE", image: "must-not-be-an-image:v0.6.0" },
    },
    {
      apiVersion: "apps/v1",
      kind: "Deployment",
      metadata: { name: "cube-templatecenter" },
      spec: {
        template: {
          spec: {
            containers: [{ name: "center", image: "pi-cloud/cube-templatecenter:reviewed" }],
            initContainers: [
              { name: "shim", image: cubeImage },
              { name: "init", image: "busybox:1.36" },
            ],
          },
        },
      },
    },
    {
      apiVersion: "batch/v1",
      kind: "CronJob",
      metadata: { name: "owned-cleaner" },
      spec: {
        jobTemplate: {
          spec: {
            template: {
              spec: {
                containers: [{ name: "curl", image: "curlimages/curl:8.10.1" }],
              },
            },
          },
        },
      },
    },
    ...extra,
  ]
    .map((value) => stringify(value))
    .join("---\n");
}
function inspection(reference, character) {
  const canonical = canonicalImageReference(reference);
  const repository = canonical.slice(0, canonical.lastIndexOf(":"));
  return {
    Id: sha(character),
    Os: "linux",
    Architecture: "amd64",
    RepoDigests: [`${repository}@${sha(character)}`],
    Config: { Env: ["DO_NOT_COPY_INSPECTION_SECRET"] },
  };
}
function fixture() {
  const text = manifest(),
    references = cubeUpstreamImageClosure(text, runtimeBuild).references;
  const inspected = new Map(
    references.map((reference, i) => [reference, inspection(reference, "abc"[i])]),
  );
  const evidence = createCubeUpstreamEvidence(text, runtimeBuild, inspected);
  return { text, inspected, evidence };
}

it("extracts the rendered deployment and init-container closure without reading Secrets as images", () => {
  const closure = cubeUpstreamImageClosure(manifest(), runtimeBuild);
  expect(closure.references).toEqual(["busybox:1.36", cubeImage, "curlimages/curl:8.10.1"].sort());
  expect(closure.manifestSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(closure)).not.toContain("VERY_PRIVATE");
});

it("includes Pod/List/Job images and excludes registry-qualified custom PiCloud artifacts", () => {
  const text = manifest([
    {
      apiVersion: "v1",
      kind: "List",
      items: [
        {
          apiVersion: "v1",
          kind: "Pod",
          metadata: { name: "check" },
          spec: { containers: [{ name: "db", image: "mysql:8.0" }] },
        },
        {
          apiVersion: "batch/v1",
          kind: "Job",
          metadata: { name: "prepare" },
          spec: {
            template: {
              spec: {
                containers: [
                  { name: "custom", image: "localhost:5000/pi-cloud/cube-master:owned" },
                ],
                initContainers: [{ name: "cache", image: "redis:7-alpine" }],
              },
            },
          },
        },
      ],
    },
  ]);
  expect(cubeUpstreamImageClosure(text, runtimeBuild).references).toEqual(
    ["busybox:1.36", cubeImage, "curlimages/curl:8.10.1", "mysql:8.0", "redis:7-alpine"].sort(),
  );
});

it.each(["v0.6.0", "v0.7.2", "latest", "v0.7.4"])("rejects unreviewed Cube tag %s", (tag) => {
  expect(() =>
    cubeUpstreamImageClosure(
      manifest().replace("cube-shim:v0.7.3", `cube-shim:${tag}`),
      runtimeBuild,
    ),
  ).toThrow("pinned upstream release");
});

it("takes the public version from runtime-build instead of a second hardcoded version list", () => {
  expect(
    cubeUpstreamImageClosure(manifest().replace("cube-shim:v0.7.3", "cube-shim:v0.8.1"), {
      upstreamVersion: "0.8.1",
    }).upstreamVersion,
  ).toBe("0.8.1");
});

it.each([
  "vendor/network-agent:v0.7.3",
  "quay.io/minio/minio:RELEASE.fixture",
  "vendor/cube-s3lvol:v0.7.3",
])("refuses unwanted deployed image %s", (image) => {
  expect(() =>
    cubeUpstreamImageClosure(
      manifest([{ kind: "Pod", spec: { containers: [{ name: "unexpected", image }] } }]),
      runtimeBuild,
    ),
  ).toThrow(/network-agent|MinIO|S3lvol/);
});

it("produces only immutable image evidence and never copies private inspect/config content", () => {
  const { evidence } = fixture();
  expect(evidence).toMatchObject({ formatVersion: 1, upstreamVersion: "0.7.3" });
  expect(evidence.images).toHaveLength(3);
  for (const row of evidence.images) {
    expect(Object.keys(row).sort()).toEqual([
      "imageId",
      "pinnedReference",
      "reference",
      "repoDigests",
    ]);
    expect(row.repoDigests).toContain(row.pinnedReference);
    expect(row.pinnedReference).toMatch(/@sha256:[0-9a-f]{64}$/);
  }
  expect(JSON.stringify(evidence)).not.toMatch(/VERY_PRIVATE|DO_NOT_COPY/);
});

it("rejects manifest drift, missing image evidence and changed local IDs before import", () => {
  const { text, evidence, inspected } = fixture();
  expect(verifyCubeUpstreamEvidence(text, runtimeBuild, evidence, inspected)).toEqual(
    evidence.images,
  );
  expect(() => verifyCubeUpstreamEvidence(`${text}\n`, runtimeBuild, evidence, inspected)).toThrow(
    "changed after",
  );
  expect(() =>
    verifyCubeUpstreamEvidence(
      text,
      runtimeBuild,
      { ...evidence, images: evidence.images.slice(1) },
      inspected,
    ),
  ).toThrow("closure differs");
  const changed = new Map(inspected);
  changed.set(evidence.images[0].reference, {
    ...changed.get(evidence.images[0].reference),
    Id: sha("d"),
  });
  expect(() => verifyCubeUpstreamEvidence(text, runtimeBuild, evidence, changed)).toThrow(
    "changed locally",
  );
  changed.delete(evidence.images[0].reference);
  expect(() => verifyCubeUpstreamEvidence(text, runtimeBuild, evidence, changed)).toThrow(
    "missing or changed",
  );
});

it("requires a matching unambiguous registry digest", () => {
  const local = inspection("busybox:1.36", "a");
  expect(() => inspectCubeUpstreamImage("busybox:1.36", { ...local, RepoDigests: [] })).toThrow(
    "immutable registry digest",
  );
  expect(() =>
    inspectCubeUpstreamImage("busybox:1.36", {
      ...local,
      RepoDigests: [`docker.io/library/other@${sha("a")}`],
    }),
  ).toThrow("missing or ambiguous");
  const ambiguous = {
    ...local,
    RepoDigests: [...local.RepoDigests, `docker.io/library/busybox@${sha("b")}`],
  };
  expect(() => inspectCubeUpstreamImage("busybox:1.36", ambiguous)).toThrow("ambiguous");
  expect(
    inspectCubeUpstreamImage("busybox:1.36", { ...ambiguous, Descriptor: { digest: sha("b") } })
      .pinnedReference,
  ).toBe(`docker.io/library/busybox@${sha("b")}`);
});

it("requires original registry manifest blobs and matching imported digest targets", () => {
  const { evidence } = fixture();
  const blobs = evidence.images
    .map((row) => `blobs/sha256/${row.pinnedReference.split("@sha256:")[1]}`)
    .join("\n");
  expect(() => assertUpstreamArchiveClosure(blobs, evidence.images)).not.toThrow();
  expect(() =>
    assertUpstreamArchiveClosure("manifest.json\nrewritten-docker-layer.tar", evidence.images),
  ).toThrow("did not preserve");
  const imported = evidence.images
    .map(
      (row) =>
        `${row.pinnedReference} application/vnd.oci.image.index.v1+json ${row.pinnedReference.split("@")[1]} 1KiB linux/amd64 -`,
    )
    .join("\n");
  expect(() => assertImportedUpstreamImages(imported, evidence.images)).not.toThrow();
  const anonymous = evidence.images
    .map((row) => {
      const hash = row.pinnedReference.split("@")[1];
      return `import-2026-11-07@${hash} application/vnd.oci.image.index.v1+json ${hash} 1KiB linux/amd64 -`;
    })
    .join("\n");
  expect(() => assertImportedUpstreamImages(anonymous, evidence.images)).toThrow(
    "K3s did not confirm",
  );
  expect(() => assertImportedUpstreamImages("", evidence.images)).toThrow("K3s did not confirm");
});

it("suppresses private YAML parse details", () => {
  try {
    cubeUpstreamImageClosure("kind: Secret\nstringData: { password: VERY_PRIVATE", runtimeBuild);
  } catch (error) {
    expect(error.message).toBe("Invalid private Cube candidate manifest YAML");
    expect(error.stack).not.toContain("VERY_PRIVATE");
    return;
  }
  throw new Error("Invalid YAML unexpectedly accepted");
});
