import assert from "node:assert/strict";
import {
  digest,
  dockerSourceInputs,
  assertProviderBuildContextChanges,
} from "./component-release.mjs";

export const retainedSandboxComponents = [
  "cube-api",
  "cube-master",
  "cubelet",
  "cube-api-authorizer",
  "cube-egress-gateway",
  "cubesandbox-tool",
];
const hostOnlyProtocol = new Set([
  "packages/protocol/src/model-metering.ts",
  "packages/protocol/src/model-billing.ts",
]);

/** ADR-0297 only: additions to the host accounting port do not change the
 * installed Cube execution interface. Prove the old copied source is intact;
 * do not turn this into a general "compatible enough" release bypass. */
export function assertMeteringRetainedInputs({ before, after, changed, copied }) {
  for (const file of changed) {
    if (file === ".dockerignore") {
      assertProviderBuildContextChanges(before(file), after(file));
      continue;
    }
    if (!copied.has(file)) continue;
    if (hostOnlyProtocol.has(file)) {
      assert.equal(before(file), null, "Retained accounting export already existed");
      continue;
    }
    if (file === "packages/protocol/src/index.ts") {
      const stripped = after(file)
        .replace(/^export \* from "\.\/model-(?:metering|billing)\.ts";\r?\n/gm, "")
        .trimEnd();
      assert.equal(stripped, before(file).trimEnd(), "Existing Cube protocol exports changed");
      continue;
    }
    assert.fail(`Accounting publication changes a retained Sandbox input: ${file}`);
  }
}

export function verifyMeteringRetention({
  baseline,
  candidate,
  capture,
  root,
  readFile,
  template,
}) {
  assert.equal(
    digest(baseline),
    candidate.retainedDeploymentDigest,
    "Installed deployment changed after retention review",
  );
  assert.equal(
    baseline.contracts.schema,
    "209_workspace_file_transfers",
    "This retention review applies only to the schema 209→210 model-accounting slice",
  );
  assert.equal(candidate.guestIdentity, baseline.contracts.guestIdentity, "Guest inputs changed");
  assert.equal(template.imageRevision, candidate.guestIdentity, "Serving Guest changed");
  const tracked = capture("git", ["ls-files"]).trim().split("\n");
  for (const [name, dockerfile] of [
    ["cube-api", null],
    ["cube-master", null],
    ["cubelet", "deploy/cubesandbox/Dockerfile.cubelet"],
    ["cube-api-authorizer", "packages/cube-api-authorizer/Dockerfile"],
    ["cube-egress-gateway", "packages/cube-egress-gateway/Dockerfile"],
  ]) {
    const revision = baseline.components[name]?.sourceRevision;
    assert(/^[0-9a-f]{40}$/.test(revision ?? ""), "Retained component lacks source provenance");
    const previous = (path) => {
      try {
        return capture("git", ["show", `${revision}:${path}`]);
      } catch {
        return null;
      }
    };
    const current = (path) => readFile(`${root}/${path}`);
    const oldTracked = capture("git", ["ls-tree", "-r", "--name-only", revision]).split("\n");
    const copied = new Set();
    if (dockerfile) {
      const docker = current(dockerfile);
      assert.equal(docker.trim(), previous(dockerfile)?.trim(), "Retained Docker inputs changed");
      for (const list of [tracked, oldTracked])
        for (const input of dockerSourceInputs(dockerfile, list, docker)) copied.add(input);
    }
    for (const file of [
      "deploy/cubesandbox/runtime-build.json",
      "deploy/cubesandbox/patches",
      "scripts/build-cubesandbox-runtime.mjs",
    ]) {
      for (const path of [...tracked, ...oldTracked])
        if (path === file || path.startsWith(`${file}/`)) copied.add(path);
    }
    assertMeteringRetainedInputs({
      before: previous,
      after: current,
      copied,
      changed: capture("git", ["diff", "--name-only", revision, candidate.revision])
        .split("\n")
        .filter(Boolean),
    });
  }
  return { completionIdentity: baseline.contracts.completionIdentity };
}

export function retainSandboxProvenance(deployment, baseline) {
  const result = structuredClone(deployment);
  for (const name of retainedSandboxComponents) {
    assert(baseline.components[name], `Missing retained evidence: ${name}`);
    result.components[name] = structuredClone(baseline.components[name]);
  }
  result.contracts.completionIdentity = baseline.contracts.completionIdentity;
  return result;
}
