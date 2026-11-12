import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { stringify } from "yaml";
import { artifactInputIdentity, physicalMaintenance } from "./release-plan.mjs";
import { inspectReleaseImage } from "./release-image-evidence.mjs";
import { assertMetadataOnlyManifests } from "./metadata-release.mjs";

it("reuses unchanged artifact inputs across a different-role change and refuses a changed COPY input", async () => {
  const root = await mkdtemp(join(tmpdir(), "pma-release-inputs-"));
  const run = promisify(execFile);
  const git = async (...args) =>
    (
      await run("git", [
        "-C",
        root,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ])
    ).stdout.trim();
  const commit = async () => {
    await git("add", ".");
    await git("commit", "-m", "Fixture");
    return git("rev-parse", "HEAD");
  };
  try {
    await git("init", "--initial-branch=main");
    await mkdir(join(root, "app"));
    await writeFile(join(root, "Dockerfile"), "FROM fixture\nCOPY app /app\n");
    await writeFile(join(root, ".dockerignore"), "runtime/\n");
    await writeFile(join(root, "app/main.mjs"), "export const value = 1;\n");
    const sourceRevision = await commit();
    const original = await artifactInputIdentity(root, sourceRevision, "Dockerfile");
    await writeFile(join(root, "other-role.mjs"), "// unrelated role\n");
    const releaseRevision = await commit();
    expect((await artifactInputIdentity(root, releaseRevision, "Dockerfile")).identity).toBe(
      original.identity,
    );
    const imageId = "sha256:" + "a".repeat(64);
    const image = {
      Id: imageId,
      Os: "linux",
      Architecture: "amd64",
      Config: {
        Labels: {
          "org.opencontainers.image.version": "original",
          "org.opencontainers.image.revision": sourceRevision,
        },
      },
    };
    const request = {
      repositoryRoot: root,
      reference: "fixture/app:original",
      labelVersion: "original",
      releaseRevision,
      artifact: {
        reference: "fixture/app:original",
        artifactId: "app",
        action: "reuse",
        expectedImageId: imageId,
        sourceRevision,
        dockerfile: "Dockerfile",
        inputIdentity: original.identity,
        unchangedSince: sourceRevision,
        unchangedInputIdentity: original.identity,
      },
    };
    const evidence = await inspectReleaseImage(request, async () => JSON.stringify([image]));
    expect(evidence.provenance.sourceRevision).toBe(sourceRevision);
    expect(evidence.provenance.releaseRevision).toBe(releaseRevision);
    await writeFile(join(root, "app/main.mjs"), "export const value = 2;\n");
    const changed = await commit();
    await expect(
      inspectReleaseImage({ ...request, releaseRevision: changed }, async () =>
        JSON.stringify([image]),
      ),
    ).rejects.toThrow("changed inputs");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("distinguishes a compatible role change from storage/native physical maintenance", () => {
  expect(physicalMaintenance(["packages/control-plane/src/session-api-main.ts"])).toMatchObject({
    storage: false,
    native: false,
  });
  expect(physicalMaintenance(["packages/web-ui/src/App.tsx"])).toMatchObject({
    storage: false,
    native: false,
  });
  expect(physicalMaintenance(["deploy/cubesandbox/cube-volume-picloud-posix.sh"])).toMatchObject({
    storage: true,
    native: true,
  });
  expect(
    physicalMaintenance(["packages/sandbox-control/src/cube-persistent-capsule.ts"]).native,
  ).toBe(true);
});

it("accepts only informational chart metadata, never a rollout hidden under the same image", () => {
  const object = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "owned", labels: { "helm.sh/chart": "chart-1" } },
    spec: {
      replicas: 1,
      template: {
        metadata: { labels: { app: "owned" } },
        spec: { containers: [{ name: "app", image: "owned@sha256:fixture" }] },
      },
    },
  };
  const next = structuredClone(object);
  next.metadata.labels["helm.sh/chart"] = "chart-2";
  expect(() => assertMetadataOnlyManifests(stringify(object), stringify(next))).not.toThrow();
  for (const mutate of [
    (value) => {
      value.spec.template.metadata.labels["helm.sh/chart"] = "chart-2";
    },
    (value) => {
      value.spec.replicas = 2;
    },
    (value) => {
      value.spec.template.spec.containers[0].image = "other";
    },
  ]) {
    const changed = structuredClone(next);
    mutate(changed);
    expect(() => assertMetadataOnlyManifests(stringify(object), stringify(changed))).toThrow(
      "runtime objects",
    );
  }
});
