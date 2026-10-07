import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { guestBuildIdentity } from "./guest-build-identity.mjs";
import { inspectReleaseImage } from "./release-image-evidence.mjs";

it("reuses a guest across application-only releases while verifying original inputs and digest evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-image-evidence-")),
    run = promisify(execFile);
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
    await mkdir(join(root, "deploy/cubesandbox"), { recursive: true });
    await writeFile(
      join(root, "deploy/cubesandbox/Dockerfile.tool"),
      "FROM fixture\nCOPY tool.mjs /opt/tool.mjs\n",
    );
    await writeFile(join(root, "tool.mjs"), "// guest\n");
    const sourceRevision = await commit(),
      guestIdentity = await guestBuildIdentity(root);
    await writeFile(join(root, "README.md"), "application release documentation\n");
    const releaseRevision = await commit();
    const digest = "sha256:" + "a".repeat(64);
    const image = {
      Id: digest,
      RepoDigests: ["guest@" + digest],
      Os: "linux",
      Architecture: "amd64",
      Config: {
        Labels: {
          "org.opencontainers.image.version": "cube-primary",
          "org.opencontainers.image.revision": sourceRevision,
        },
      },
    };
    const capture = async () => JSON.stringify([image]);
    const request = {
      repositoryRoot: root,
      releaseRevision,
      reference: "guest:" + guestIdentity,
      labelVersion: "cube-primary",
      guestIdentity,
    };
    const evidence = await inspectReleaseImage(request, capture);
    expect(evidence.provenance).toEqual({
      sourceRevision,
      releaseRevision,
      guestBuildIdentity: guestIdentity,
      reusedSource: true,
    });
    expect(evidence.imageId).toBe(digest);
    expect(evidence.repoDigests).toEqual(["guest@" + digest]);
    expect(evidence.labels.revision).toBe(sourceRevision);
    // The same provenance relaxation is never applied to application images.
    const { guestIdentity: _guest, ...application } = request;
    await expect(inspectReleaseImage(application, capture)).rejects.toThrow("wrong OCI revision");
    await writeFile(join(root, "tool.mjs"), "// changed guest\n");
    await expect(
      inspectReleaseImage({ ...request, guestIdentity: await guestBuildIdentity(root) }, capture),
    ).rejects.toThrow("required guest build inputs");
    image.Config.Labels["org.opencontainers.image.revision"] = "f".repeat(40);
    await expect(inspectReleaseImage(request, capture)).rejects.toThrow();
    image.Config.Labels["org.opencontainers.image.revision"] = sourceRevision;
    image.Id = "mutable-tag";
    await expect(inspectReleaseImage(request, capture)).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
