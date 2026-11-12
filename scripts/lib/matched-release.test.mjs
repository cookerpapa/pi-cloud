import { digest } from "./component-release.mjs";
import { expect, it } from "vitest";
import { mkdtemp, mkdir, writeFile, readFile, rm, chmod } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { verifyMatchedRelease, matchedMachineDrained } from "./matched-release.mjs";
import { guestBuildIdentity } from "./guest-build-identity.mjs";

it("retains a failed machine record only after closed compute and holder retirement", () => {
  const absent = {
    state: "failed",
    allocation_closed: true,
    allocation_absent: true,
    runtime_capsule: null,
    runtime_id: null,
    runtime_name: null,
    agent_activation_id: null,
    terminal_active: false,
  };
  expect(matchedMachineDrained(absent)).toBe(true);
  expect(matchedMachineDrained({ ...absent, state: "reconciling" })).toBe(true);
  for (const change of [
    { state: "running" },
    { state: "unknown" },
    { allocation_closed: false },
    { allocation_absent: false },
    { runtime_capsule: "unretired-capsule" },
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
    for (const file of ["Dockerfile.tool"])
      await writeFile(
        join(root, "deploy/cubesandbox", file),
        "FROM fixture\nCOPY input.txt /input\n",
      );
    await writeFile(join(root, "deploy/cubesandbox/runtime-build.json"), "{}");
    await writeFile(join(root, "input.txt"), "fixture");
    const revision = "a".repeat(40),
      version = "candidate";
    const guestIdentity = await guestBuildIdentity(root);
    const catalog = Object.fromEntries(
      ["controlPlane", "provider", "relay", "sshGateway", "volumeGateway", "web", "worker"].map(
        (name) => [name, `fixture/${name}:${version}`],
      ),
    );
    catalog.sessionRuntime = catalog.controlPlane;
    catalog.sessionApi = catalog.controlPlane;
    catalog.toolCompletion = catalog.controlPlane;
    catalog.metering = catalog.controlPlane;
    catalog.toolHost = catalog.controlPlane;
    const references = [
      ...new Set(Object.values(catalog)),
      ...[
        "cube-api",
        "cube-master",
        "cube-templatecenter",
        "cubelet",
        "cube-api-authorizer",
        "cube-egress-gateway",
      ].map((name) => `pi-cloud/${name}:${version}`),
      `localhost:5000/pi-cloud/cubesandbox-tool:${guestIdentity}`,
    ];
    await mkdir(join(root, "evidence"));
    const baseline = { formatVersion: 1, revision, version: "before", components: {} };
    const plan = {
      formatVersion: 1,
      revision,
      version,
      guestIdentity,
      nativeVersion: version,
      baselineDigest: digest(baseline),
      images: catalog,
      artifacts: references.map((reference, index) => ({
        artifactId: `artifact-${index}`,
        reference,
        action: "build",
        sourceRevision: revision,
        inputIdentity: "f".repeat(64),
      })),
    };
    await writeFile(join(root, "baseline.json"), JSON.stringify(baseline));
    await writeFile(join(root, "release-plan.json"), JSON.stringify(plan));
    await writeFile(
      join(root, "candidate.json"),
      JSON.stringify({
        formatVersion: 2,
        revision,
        version,
        nativeVersion: version,
        guestIdentity,
        baselineDigest: digest(baseline),
        releasePlanDigest: digest(plan),
      }),
    );
    await writeFile(join(root, "images.json"), JSON.stringify(catalog));
    const report = { path: "report.json" };
    const manifest = {
      format: "pi-cloud.release-evidence.v1",
      scope: "all",
      git: { revision, dirty: false },
      imageVersion: version,
      rootSbom: report,
      policy: { exceptionPolicy: report },
      images: references.map((reference) => ({
        reference,
        provenance: { sourceRevision: revision, inputIdentity: "f".repeat(64) },
        imageId: "sha256:" + "b".repeat(64),
        repoDigests: [`${reference}@sha256:${"d".repeat(64)}`],
        sbom: report,
        vulnerabilityReport: report,
        policyVulnerabilityReport: report,
        policyVulnerabilities: { HIGH: { fixable: 0 }, CRITICAL: { fixable: 0 } },
      })),
    };
    await writeFile(join(root, "evidence/report.json"), "{}");
    const writeEvidence = async () => {
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
    };
    await writeEvidence();
    const calls = [];
    let replaced = false;
    let operatorRevision = revision;
    let changedFiles = [];
    const capture = async (cmd, args) => {
      calls.push(cmd);
      if (cmd === "git") {
        if (args[0] === "diff") expect(args).toContain("--no-renames");
        return args[0] === "rev-parse"
          ? operatorRevision
          : args[0] === "diff"
            ? changedFiles.join("\n")
            : "";
      }
      if (cmd === "docker")
        return JSON.stringify([{ Id: "sha256:" + (replaced ? "c" : "b").repeat(64) }]);
      throw new Error("Preflight attempted a cluster mutation");
    };
    expect((await verifyMatchedRelease({ directory: root, root, capture })).revision).toBe(
      revision,
    );
    expect(references).toHaveLength(14);
    await writeFile(
      join(root, "images.json"),
      JSON.stringify({ ...catalog, toolHost: catalog.worker }),
    );
    await expect(verifyMatchedRelease({ directory: root, root, capture })).rejects.toThrow(
      "role catalog differs",
    );
    await writeFile(join(root, "images.json"), JSON.stringify(catalog));
    operatorRevision = "d".repeat(40);
    changedFiles = [
      "scripts/lib/matched-release.mjs",
      "scripts/lib/matched-release.test.mjs",
      "docs/adr/0305-execution-owned-tools-and-bindings.md",
    ];
    const adopted = await verifyMatchedRelease({ directory: root, root, capture });
    expect(adopted.revision).toBe(revision);
    expect(adopted.operatorRevision).toBe(operatorRevision);
    changedFiles = ["packages/control-plane/src/tool-host-main.ts"];
    await expect(verifyMatchedRelease({ directory: root, root, capture })).rejects.toThrow(
      "runtime inputs changed",
    );
    operatorRevision = revision;
    changedFiles = [];
    const templateIndex = manifest.images.findIndex(
      (image) => image.reference === `pi-cloud/cube-templatecenter:${version}`,
    );
    const template = manifest.images[templateIndex];
    manifest.images.splice(templateIndex, 1);
    await writeEvidence();
    await expect(verifyMatchedRelease({ directory: root, root, capture })).rejects.toThrow(
      "planned artifacts",
    );
    manifest.images.splice(templateIndex, 0, {
      ...template,
      reference: "registry.example/official/cube-templatecenter:0.7.3",
    });
    await writeEvidence();
    await expect(verifyMatchedRelease({ directory: root, root, capture })).rejects.toThrow(
      "absent from the release plan",
    );
    manifest.images[templateIndex] = template;
    await writeEvidence();
    const webIndex = manifest.images.findIndex((image) => image.reference === catalog.web);
    const web = manifest.images[webIndex];
    manifest.images[webIndex] = {
      ...web,
      reference: "registry.example/official/chart-helper:0.7.3",
    };
    await writeFile(join(root, "images.json"), JSON.stringify({ ...catalog, web: catalog.worker }));
    await writeEvidence();
    await expect(verifyMatchedRelease({ directory: root, root, capture })).rejects.toThrow(
      "absent from the release plan",
    );
    manifest.images[webIndex] = web;
    await writeFile(join(root, "images.json"), JSON.stringify(catalog));
    await writeEvidence();
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
      "role catalog differs",
    );
    await writeFile(join(root, "images.json"), JSON.stringify(catalog));
    await writeFile(
      join(root, "release-plan.json"),
      JSON.stringify({ ...plan, version: "tampered" }),
    );
    await expect(verifyMatchedRelease({ directory: root, root, capture })).rejects.toThrow(
      "Release plan changed",
    );
    await writeFile(join(root, "release-plan.json"), JSON.stringify(plan));
    manifest.images[0].policyVulnerabilities.HIGH.fixable = 1;
    await writeEvidence();
    await expect(verifyMatchedRelease({ directory: root, root, capture })).rejects.toThrow(
      "security gate failed",
    );
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
