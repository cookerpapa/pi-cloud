import {
  catalogSeed,
  operatorSources,
  modelTests,
  ordinaryControlToolSource,
  imageReleaseTargets,
  providerSources,
} from "./release-impact.mjs";
export { catalogSeed } from "./release-impact.mjs";
export { imageReleaseTargets } from "./release-impact.mjs";
import { isDeepStrictEqual } from "node:util";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parseAllDocuments } from "yaml";

export const digest = (value) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");

export function dockerSourceInputs(dockerfile, tracked, content) {
  const inputs = new Set([dockerfile, ".dockerignore"]);
  for (const line of content.replace(/\\\r?\n\s*/gu, " ").split("\n")) {
    if (!line.startsWith("COPY ") || /--from=/u.test(line)) continue;
    const tokens = line
      .slice(5)
      .split(/\s+/u)
      .filter((token) => !token.startsWith("--"));
    for (const source of tokens.slice(0, -1)) {
      const files = tracked.filter((file) => file === source || file.startsWith(`${source}/`));
      assert(files.length, `Untracked COPY input: ${source}`);
      for (const file of files) inputs.add(file);
    }
  }
  return [...inputs].sort();
}

export function assertOperatorRevisionChanges(files) {
  for (const file of files)
    assert(
      operatorSources.has(file) ||
        modelTests.has(file) ||
        file === "README.md" ||
        file === "AGENTS.md" ||
        file.startsWith("docs/"),
      `Prepared runtime inputs changed: ${file}`,
    );
}

export function scopedHelmUpgradeArguments({ name, chart, values, kubeconfig, namespace }) {
  const args = [
    "upgrade",
    name,
    chart,
    "--values",
    values,
    "--no-hooks",
    "--wait",
    "--timeout",
    "5m",
    "--kubeconfig",
    kubeconfig,
    "--namespace",
    namespace,
  ];
  assert(
    args.every((value) => typeof value === "string" && value.length > 0),
    "Helm arguments must be nonempty strings",
  );
  return args;
}

export function scopedApplyState({ baseline, next, current, helmRevision, before, desired, live }) {
  assert(
    [digest(baseline), digest(next)].includes(digest(current)),
    "Another component release changed the baseline",
  );
  if (manifestDigest(live.manifest) === manifestDigest(desired)) return "verify";
  assert.equal(live.status.version, helmRevision, "Helm baseline changed");
  assert.equal(manifestDigest(live.manifest), manifestDigest(before), "Helm resources changed");
  return "apply";
}

/** Source classifications are deliberately small; protocol changes use matched release. */
export function assertScopedSources(scope, files) {
  assert(["provider", "catalog", "web", "control-plane"].includes(scope), "Unknown release scope");
  for (const file of files) {
    assert(
      operatorSources.has(file) ||
        (scope === "control-plane" && ordinaryControlToolSource(file)) ||
        (scope === "web" &&
          (/^packages\/web-ui\/src\/.*\.(tsx|css)$/.test(file) ||
            [
              "session-view.ts",
              "conversation-presentation.ts",
              "virtual-conversation-rows.ts",
            ].some((name) => file === `packages/web-ui/src/${name}`) ||
            [
              "scripts/production-kubernetes.mjs",
              "scripts/run-browser-presentation-check.mjs",
              "scripts/run-browser-queue-check.mjs",
              "scripts/run-live-browser-ui-check.mjs",
              "scripts/run-live-queue-input-check.mjs",
              "scripts/run-live-release-acceptance.mjs",
              "scripts/run-live-review-repair-check.mjs",
              "scripts/run-live-development-environment-check.mjs",
              "scripts/run-live-missing-directory-check.mjs",
            ].includes(file))) ||
        (["provider", "catalog"].includes(scope) &&
          (file === catalogSeed || file === "deploy/provider-gateway/Dockerfile")) ||
        (scope === "provider" && providerSources.has(file)) ||
        file === "README.md" ||
        file === "AGENTS.md" ||
        file.startsWith("docs/") ||
        /(?:^|\/)test\/.*\.test\.[cm]?tsx?$/.test(file) ||
        /^scripts\/lib\/.*\.test\.mjs$/.test(file),
      `Change requires a matched release: ${file}`,
    );
  }
}

function manifests(text) {
  const result = new Map();
  for (const document of parseAllDocuments(text)) {
    assert.equal(document.errors.length, 0, "Invalid Helm manifest");
    const value = document.toJSON();
    if (!value || value.metadata?.annotations?.["helm.sh/hook"]) continue;
    const key = `${value.apiVersion}/${value.kind}/${value.metadata?.namespace ?? ""}/${value.metadata?.name}`;
    assert(!result.has(key), "Duplicate rendered resource");
    result.set(key, value);
  }
  return result;
}

export function manifestDigest(text) {
  const canonical = (value) =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.keys(value)
              .sort()
              .map((key) => [key, canonical(value[key])]),
          )
        : value;
  return digest(
    [...manifests(text)]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => [key, canonical(value)]),
  );
}

/** Compare whole desired objects, not a loose list of changed resource names. */
export function assertScopedManifests(scope, before, after, desired) {
  const previous = manifests(before),
    next = manifests(after);
  assert.deepEqual(
    [...previous.keys()].sort(),
    [...next.keys()].sort(),
    "Scoped release cannot create/delete resources",
  );
  let targets = 0;
  for (const [key, old] of previous) {
    const expected = structuredClone(old);
    if (
      scope === "provider" &&
      old.kind === "StatefulSet" &&
      old.metadata.name === "cli-proxy-api"
    ) {
      const container = expected.spec.template.spec.containers.find(
        (c) => c.name === "cli-proxy-api",
      );
      assert(container, "Missing provider container");
      container.image = desired;
      // ADR-0289: repair Helm's float spelling without changing a configured
      // value or permitting unrelated environment/template changes.
      const incoming = next
        .get(key)
        ?.spec.template.spec.containers.find((c) => c.name === "cli-proxy-api");
      const integerNames = new Set([
        "PI_CLOUD_MODEL_REQUEST_MAX_BYTES",
        "PI_CLOUD_MODEL_UPLOAD_MAX_BYTES",
        "PI_CLOUD_MODEL_SESSION_IDLE_SECONDS",
        "PI_CLOUD_MODEL_SESSION_CACHE_ENTRIES",
      ]);
      for (const env of container.env ?? []) {
        const other = incoming?.env?.find((e) => e.name === env.name);
        if (
          integerNames.has(env.name) &&
          typeof env.value === "string" &&
          typeof other?.value === "string" &&
          /^\d+$/.test(other.value) &&
          Number.isSafeInteger(Number(env.value)) &&
          Number(env.value) === Number(other.value)
        )
          env.value = other.value;
      }
      targets++;
    } else if (
      ["web", "control-plane"].includes(scope) &&
      old.kind === "Deployment" &&
      old.metadata.name === imageReleaseTargets[scope].workload.split("/")[1]
    ) {
      const container = expected.spec.template.spec.containers.find(
        (c) => c.name === imageReleaseTargets[scope].container,
      );
      assert(container, "Missing component container");
      container.image = desired;
      targets++;
    } else if (
      scope === "catalog" &&
      old.kind === "ConfigMap" &&
      old.metadata.name === "pi-cloud-model-catalog"
    ) {
      expected.data["model-catalog.json"] = desired;
      // YAML block scalars can add a final newline; compare JSON semantics only for this data field.
      const actual = structuredClone(next.get(key));
      actual.data["model-catalog.json"] = JSON.stringify(
        JSON.parse(actual.data["model-catalog.json"]),
      );
      expected.data["model-catalog.json"] = JSON.stringify(JSON.parse(desired));
      assert(isDeepStrictEqual(actual, expected), "Catalog publication changed other fields");
      targets++;
      continue;
    }
    assert(
      isDeepStrictEqual(next.get(key), expected),
      `Unexpected resource change: ${old.kind}/${old.metadata.name}`,
    );
  }
  assert.equal(targets, 1, "Expected exactly one scoped target");
}

export function deploymentFromEvidence({
  evidence,
  evidenceDirectory,
  revision,
  version,
  catalogRevision,
  contracts,
}) {
  const components = {};
  for (const image of evidence.images) {
    const name = image.reference.split("/").at(-1).split(":")[0];
    assert(!components[name], "Duplicate component provenance");
    components[name] = {
      reference: image.reference,
      imageId: image.imageId,
      repoDigests: image.repoDigests,
      sourceRevision: image.provenance.sourceRevision,
      evidence: { directory: evidenceDirectory, manifestSha256: digest(evidence) },
    };
  }
  return { formatVersion: 1, revision, version, catalogRevision, contracts, components };
}

export function composeScopedDeployment(
  baseline,
  { scope, version, revision, catalogRevision, evidence, evidenceDirectory },
) {
  assert.equal(baseline.formatVersion, 1);
  const result = structuredClone(baseline);
  result.revision = revision;
  result.version = version;
  if (scope === "catalog") result.catalogRevision = catalogRevision;
  else {
    assert(imageReleaseTargets[scope], "Unknown image release scope");
    const name = imageReleaseTargets[scope].imageName;
    assert.equal(evidence.images.length, 1, "Component evidence must cover one image");
    const image = evidence.images[0];
    assert(image.reference.startsWith(`pi-cloud/${name}:`));
    assert.equal(
      image.policyVulnerabilities.HIGH.fixable + image.policyVulnerabilities.CRITICAL.fixable,
      0,
      "Component image scan failed",
    );
    result.components[name] = deploymentFromEvidence({
      evidence,
      evidenceDirectory,
      revision,
      version,
    }).components[name];
  }
  return result;
}
