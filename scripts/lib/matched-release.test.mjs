import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { verifyMatchedRelease, matchedMachineDrained } from "./matched-release.mjs";
import { guestBuildIdentity, completionBuildIdentity } from "./guest-build-identity.mjs";

it("retains a failed machine record only after closed compute and holder retirement", () => {
  const absent = {
    state: "failed",
    allocation_closed: true,
    runtime_id: null,
    runtime_name: null,
    agent_activation_id: null,
    terminal_active: false,
  };
  expect(matchedMachineDrained(absent)).toBe(true);
  for (const change of [
    { state: "running" },
    { state: "unknown" },
    { allocation_closed: false },
    { runtime_id: "old-physical-id" },
    { runtime_name: "old-target" },
    { agent_activation_id: "active-holder" },
    { terminal_active: true },
  ])
    expect(matchedMachineDrained({ ...absent, ...change })).toBe(false);
});

it("checks scanned image identity before any mutation and rejects catalog substitution", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-candidate-test-"));
  try {
    await mkdir(join(root, "deploy/cubesandbox"), { recursive: true });
    for (const file of ["Dockerfile.tool", "Dockerfile.cubelet"])
      await writeFile(
        join(root, "deploy/cubesandbox", file),
        "FROM fixture\nCOPY input.txt /input\n",
      );
    await writeFile(join(root, "deploy/cubesandbox/runtime-build.json"), "{}");
    await writeFile(join(root, "input.txt"), "fixture");
    const revision = "a".repeat(40),
      version = "candidate";
    const guestIdentity = await guestBuildIdentity(root);
    const completionIdentity = await completionBuildIdentity(root);
    const catalog = Object.fromEntries(
      ["controlPlane", "provider", "relay", "sshGateway", "volumeGateway", "web", "worker"].map(
        (name) => [name, `fixture/${name}:${version}`],
      ),
    );
    const references = [
      ...Object.values(catalog),
      ...["cube-api", "cube-master", "cubelet", "cube-api-authorizer"].map(
        (name) => `pi-cloud/${name}:${version}`,
      ),
      `localhost:5000/pi-cloud/cubesandbox-tool:${guestIdentity}`,
    ];
    await mkdir(join(root, "evidence"));
    await writeFile(
      join(root, "candidate.json"),
      JSON.stringify({ formatVersion: 1, revision, version, guestIdentity, completionIdentity }),
    );
    await writeFile(join(root, "images.json"), JSON.stringify(catalog));
    const report = { path: "report.json" };
    const manifest = {
      format: "pi-cloud.release-evidence.v1",
      git: { revision, dirty: false },
      imageVersion: version,
      rootSbom: report,
      policy: { exceptionPolicy: report },
      images: references.map((reference) => ({
        reference,
        imageId: "sha256:" + "b".repeat(64),
        repoDigests: [`${reference}@sha256:${"d".repeat(64)}`],
        sbom: report,
        vulnerabilityReport: report,
        policyVulnerabilityReport: report,
        policyVulnerabilities: { HIGH: { fixable: 0 }, CRITICAL: { fixable: 0 } },
      })),
    };
    await writeFile(join(root, "evidence/report.json"), "{}");
    await writeFile(join(root, "evidence/manifest.json"), JSON.stringify(manifest));
    const checksums = [];
    for (const file of ["report.json", "manifest.json"])
      checksums.push(
        createHash("sha256")
          .update(await readFile(join(root, "evidence", file)))
          .digest("hex") +
          "  " +
          file,
      );
    await writeFile(join(root, "evidence/SHA256SUMS"), checksums.join("\n"));
    const calls = [];
    let replaced = false;
    const capture = async (cmd, args) => {
      calls.push(cmd);
      if (cmd === "git") return args[0] === "rev-parse" ? revision : "";
      if (cmd === "docker")
        return JSON.stringify([{ Id: "sha256:" + (replaced ? "c" : "b").repeat(64) }]);
      throw new Error("Preflight attempted a cluster mutation");
    };
    expect((await verifyMatchedRelease({ directory: root, root, capture })).revision).toBe(
      revision,
    );
    expect(
      (
        await verifyMatchedRelease({
          directory: root,
          root,
          capture,
          currentGuestTemplate: {
            imageRevision: guestIdentity,
            imageDigest: "sha256:" + "d".repeat(64),
          },
        })
      ).guestImageId,
    ).toBe("sha256:" + "b".repeat(64));
    await expect(
      verifyMatchedRelease({
        directory: root,
        root,
        capture,
        currentGuestTemplate: {
          imageRevision: guestIdentity,
          imageDigest: "sha256:" + "e".repeat(64),
        },
      }),
    ).rejects.toThrow("template selected for reuse");
    replaced = true;
    await expect(verifyMatchedRelease({ directory: root, root, capture })).rejects.toThrow(
      "Scanned image was replaced",
    );
    replaced = false;
    await writeFile(
      join(root, "images.json"),
      JSON.stringify({ ...catalog, worker: "unscanned:latest" }),
    );
    await expect(verifyMatchedRelease({ directory: root, root, capture })).rejects.toThrow(
      "Unscanned image",
    );
    expect(new Set(calls)).toEqual(new Set(["git", "docker"]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("the apply CLI does not call Kubernetes when its candidate preflight fails", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-cloud-release-refusal-"));
  try {
    const binary = join(directory, "kubectl");
    await writeFile(binary, '#!/bin/sh\necho MUTATED > "$PI_CLOUD_FIXTURE_TRACE"\nexit 1\n');
    await chmod(binary, 0o755);
    const trace = join(directory, "trace");
    await mkdir(join(directory, "cubesandbox"));
    await writeFile(join(directory, "cubesandbox/template.json"), "{}");
    await expect(
      promisify(execFile)(
        process.execPath,
        ["--import", "tsx", "scripts/run-matched-release.mjs", "apply", directory],
        {
          env: {
            ...process.env,
            PI_CLOUD_KUBECTL_BIN: binary,
            PI_CLOUD_FIXTURE_TRACE: trace,
            PI_CLOUD_RUNTIME_DIRECTORY: directory,
          },
        },
      ),
    ).rejects.toThrow();
    await expect(readFile(trace)).rejects.toThrow("ENOENT");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
