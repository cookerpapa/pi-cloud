import {
  catalogSeed,
  operatorSources,
  modelTests,
  ordinaryControlToolSource,
  sessionDecoderSource,
  sessionRetentionSource,
  workerBootstrapSource,
  sessionApiSource,
  imageReleaseTargets,
  providerSources,
} from "./release-impact.mjs";
export { catalogSeed } from "./release-impact.mjs";
export { imageReleaseTargets } from "./release-impact.mjs";
import { isDeepStrictEqual } from "node:util";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parseAllDocuments } from "yaml";
import ts from "typescript";

/** The initializer also owns other infrastructure. Only its provider declaration
 * and pinned provider import/asset may differ in a provider-only publication. */
export function assertProviderInitializerChanges(before, after) {
  const unrelated = (source) => {
    const file = ts.createSourceFile(
      "init-production.mjs",
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.JS,
    );
    return file.statements
      .filter((node) => {
        if (ts.isFunctionDeclaration(node) && node.name?.text === "ensureCliProxyRuntime")
          return false;
        if (
          ts.isImportDeclaration(node) &&
          node.moduleSpecifier.text === "./lib/provider-runtime-config.mjs"
        )
          return false;
        if (
          ts.isVariableStatement(node) &&
          node.declarationList.declarations.length === 1 &&
          node.declarationList.declarations[0].name.getText(file) === "cliProxyManagementAsset"
        )
          return false;
        return true;
      })
      .map((node) => node.getText(file))
      .join("\n");
  };
  assert.equal(
    unrelated(before),
    unrelated(after),
    "Provider release changes unrelated initialization",
  );
}

/** A provider release may expose its own Go/patch inputs, never broaden other
 * build contexts or admit deployment secrets. The context probe still runs. */
export function assertProviderBuildContextChanges(before, after) {
  const unrelated = (source) =>
    source
      .trim()
      .split(/\r?\n/)
      .filter((line) => !/^!deploy\/provider-gateway\/[A-Za-z0-9_.-]+\.(go|patch)$/.test(line))
      .join("\n");
  assert.equal(
    unrelated(before),
    unrelated(after),
    "Provider release changes unrelated build context",
  );
}

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

export function scopedHelmUpgradeArguments({
  name,
  chart,
  values,
  kubeconfig,
  namespace,
  wait = true,
}) {
  const args = [
    "upgrade",
    name,
    chart,
    "--values",
    values,
    "--no-hooks",
    ...(wait ? ["--wait"] : []),
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
export function assertScopedSources(scope, files, runtimeInputs) {
  assert(scope === "catalog" || Object.hasOwn(imageReleaseTargets, scope), "Unknown release scope");
  for (const file of files) {
    assert(
      operatorSources.has(file) ||
        // BoxLite node code is independently published and is absent from the
        // ordinary role images. Require the selected Docker input closure to
        // prove that absence; never excuse shared provider/protocol changes.
        (runtimeInputs instanceof Set &&
          file.startsWith("packages/boxlite-node/src/") &&
          !runtimeInputs.has(file)) ||
        (scope === "tool-host" && ordinaryControlToolSource(file)) ||
        (scope === "tool-host" &&
          file === "deploy/helm/pi-cloud-platform/templates/network-policy.yaml") ||
        (scope === "session-decoder" && file === sessionDecoderSource) ||
        (scope === "session-retention" && file === sessionRetentionSource) ||
        (scope === "worker-bootstrap" &&
          (file === workerBootstrapSource || file === "scripts/production-kubernetes.mjs")) ||
        (scope === "session-api" && sessionApiSource(file)) ||
        (scope === "web" &&
          (file === "packages/web-ui/index.html" ||
            /^packages\/web-ui\/src\/.*\.(tsx|css)$/.test(file) ||
            [
              "session-view.ts",
              "conversation-presentation.ts",
              "virtual-conversation-rows.ts",
              "composer-submission.ts",
              "submission-presentation.ts",
            ].some((name) => file === `packages/web-ui/src/${name}`) ||
            [
              "scripts/production-kubernetes.mjs",
              "scripts/run-browser-presentation-check.mjs",
              "scripts/run-browser-queue-check.mjs",
              "scripts/run-skill-market-browser-check.mjs",
              "scripts/run-live-skill-market-browser-check.mjs",
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

/** A built artifact can serve several roles; only the requested role value changes. */
export function scopedImageValues(scope, values, desired, version) {
  const target = imageReleaseTargets[scope];
  assert(target, "Unknown image release scope");
  assert.equal(
    desired,
    `pi-cloud/${target.imageName}:${version}`,
    "Scoped artifact identity changed",
  );
  const next = structuredClone(values);
  if (scope === "provider") next.provider.image = desired;
  else if (scope === "worker-bootstrap") {
    assert(next["pi-workers"]?.image, "Installed Worker image values are required");
    next["pi-workers"].image = {
      ...next["pi-workers"].image,
      repository: "pi-cloud/supervisor-host",
      tag: version,
    };
    delete next["pi-workers"].image.digest;
  } else {
    assert(
      next.images?.[target.catalogKey],
      "Install independent role image values before a scoped release",
    );
    next.images[target.catalogKey] = {
      ...next.images[target.catalogKey],
      repository: `pi-cloud/${target.imageName}`,
      tag: version,
    };
    delete next.images[target.catalogKey].digest;
  }
  return next;
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
      scope === "tool-host" &&
      old.kind === "NetworkPolicy" &&
      old.metadata.name === "pi-cloud-session-runtime"
    ) {
      const labels = old.spec.podSelector.matchLabels;
      assert.equal(labels["app.kubernetes.io/component"], "session-runtime");
      const rule = {
        to: [
          {
            podSelector: {
              matchLabels: {
                "app.kubernetes.io/instance": labels["app.kubernetes.io/instance"],
                "app.kubernetes.io/component": "tool-host",
              },
            },
          },
        ],
        ports: [{ protocol: "TCP", port: 4310 }],
      };
      if (!expected.spec.egress.some((item) => isDeepStrictEqual(item, rule)))
        expected.spec.egress.unshift(rule);
    } else if (
      scope === "worker-bootstrap" &&
      old.kind === "StatefulSet" &&
      old.metadata.name === "pi-cloud-pi-worker-primary-v1"
    ) {
      const container = expected.spec.template.spec.containers.find((c) => c.name === "pi-worker");
      assert(container, "Missing Worker container");
      container.image = desired;
      targets++;
    } else if (
      ["web", "tool-host", "session-decoder", "session-api", "session-retention"].includes(scope) &&
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

export const sharedHostRoles = {
  "control-plane": { workload: "pi-cloud-control-plane", container: "control-plane" },
  "session-runtime": { workload: "pi-cloud-session-runtime", container: "session-runtime" },
  "session-api": { workload: "pi-cloud-session-api", container: "session-api" },
  "tool-completion": { workload: "pi-cloud-tool-completion", container: "tool-completion" },
  metering: { workload: "pi-cloud-metering", container: "metering" },
  "tool-host": { workload: "pi-cloud-tool-host", container: "tool-host" },
};

export function assertServingComponents(deployment, resources, alternative) {
  // The baseline describes roles already installed. A matched release may
  // introduce another role; scoped publication separately requires its contract.
  const requiredRoles = ["control-plane", "session-runtime", "metering"];
  if (deployment.contracts?.toolHostReplacement === 1) requiredRoles.push("tool-host");
  if (deployment.contracts?.sessionApiReplacement === 1) requiredRoles.push("session-api");
  if (deployment.contracts?.guestHttpCompletion === 1) requiredRoles.push("tool-completion");
  for (const role of requiredRoles)
    assert(
      deployment.components[role],
      "Install the matched role manifest before a scoped release",
    );
  const images = new Set(
    resources.flatMap((resource) =>
      resource.spec.template.spec.containers.map((container) => container.image),
    ),
  );
  for (const [name, component] of Object.entries(deployment.components)) {
    if (name === "cubesandbox-tool") continue;
    const role = sharedHostRoles[name];
    if (role) {
      const workload = resources.find(
        (resource) => resource.kind === "Deployment" && resource.metadata.name === role.workload,
      );
      const container = workload?.spec.template.spec.containers.find(
        (candidate) => candidate.name === role.container,
      );
      assert(container, `Missing serving role: ${name}`);
      assert(
        container.image === component.reference ||
          (name === alternative?.name && container.image === alternative.reference),
        `Serving role differs from its record: ${name}`,
      );
    } else
      assert(
        images.has(component.reference) ||
          (name === alternative?.name && images.has(alternative.reference)),
        `Serving component differs from its record: ${name}`,
      );
  }
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
    const component = {
      reference: image.reference,
      imageId: image.imageId,
      repoDigests: image.repoDigests,
      sourceRevision: image.provenance.sourceRevision,
      evidence: { directory: evidenceDirectory, manifestSha256: digest(evidence) },
    };
    for (const role of name === "control-plane" ? Object.keys(sharedHostRoles) : [name]) {
      assert(!components[role], "Duplicate role provenance");
      components[role] = structuredClone(component);
    }
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
    const target = imageReleaseTargets[scope];
    const name = target.imageName;
    const role = target.componentName ?? name;
    if (["tool-host", "session-decoder", "session-retention"].includes(scope))
      for (const shared of Object.keys(sharedHostRoles))
        assert(
          baseline.components[shared],
          "Install the matched role manifest before a scoped release",
        );
    assert(baseline.components[role], "Install the matched role manifest before a scoped release");
    assert.equal(evidence.images.length, 1, "Component evidence must cover one image");
    const image = evidence.images[0];
    assert(image.reference.startsWith(`pi-cloud/${name}:`));
    assert.equal(
      image.policyVulnerabilities.HIGH.fixable + image.policyVulnerabilities.CRITICAL.fixable,
      0,
      "Component image scan failed",
    );
    result.components[role] = deploymentFromEvidence({
      evidence,
      evidenceDirectory,
      revision,
      version,
    }).components[role];
  }
  return result;
}
