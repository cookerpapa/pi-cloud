import { expect, it } from "vitest";
import { stringify } from "yaml";
import {
  assertProviderInitializerChanges,
  assertProviderBuildContextChanges,
  assertScopedSources,
  assertOperatorRevisionChanges,
  scopedHelmUpgradeArguments,
  assertScopedManifests,
  composeScopedDeployment,
  deploymentFromEvidence,
  scopedImageValues,
  assertServingComponents,
  scopedApplyState,
  dockerSourceInputs,
} from "./component-release.mjs";

const provider = {
  apiVersion: "apps/v1",
  kind: "StatefulSet",
  metadata: { name: "cli-proxy-api" },
  spec: {
    replicas: 1,
    template: {
      spec: {
        containers: [{ name: "cli-proxy-api", image: "old" }],
        volumes: [{ name: "data", persistentVolumeClaim: { claimName: "retained" } }],
      },
    },
  },
};
const other = {
  apiVersion: "apps/v1",
  kind: "Deployment",
  metadata: { name: "worker" },
  spec: { replicas: 2 },
};
const yaml = (...objects) => objects.map(stringify).join("\n---\n");

it("allows only explicit provider Go and patch additions to the build context", () => {
  const before = "**\n!packages/**\n!deploy/provider-gateway/model_sessions.go\n.env\n";
  expect(() =>
    assertProviderBuildContextChanges(before, before + "!deploy/provider-gateway/config_v8.go\n"),
  ).not.toThrow();
  expect(() =>
    assertProviderBuildContextChanges(before, before + "!deploy/production/runtime/**\n"),
  ).toThrow("unrelated build context");
  expect(() => assertProviderBuildContextChanges(before, before.replace(".env\n", ""))).toThrow(
    "unrelated build context",
  );
});

it("allows only provider initialization to change in a provider release", () => {
  const before =
    'const shared = 1;\nconst cliProxyManagementAsset = {};\nasync function ensureCliProxyRuntime() { return "old"; }\nasync function postgres() { return shared; }';
  const after =
    'import { initialProviderConfiguration } from "./lib/provider-runtime-config.mjs";\nconst shared = 1;\nasync function ensureCliProxyRuntime() { return initialProviderConfiguration({}); }\nasync function postgres() { return shared; }';
  expect(() => assertProviderInitializerChanges(before, after)).not.toThrow();
  expect(() =>
    assertProviderInitializerChanges(before, after.replace("shared = 1", "shared = 2")),
  ).toThrow("unrelated initialization");
  expect(() =>
    assertProviderInitializerChanges(before, after.replace("return shared;", "throw new Error();")),
  ).toThrow("unrelated initialization");
});

it("accepts operator-only replacement repairs without relabeling the prepared runtime", () => {
  expect(() =>
    assertOperatorRevisionChanges([
      "scripts/lib/tool-host-release.mjs",
      "scripts/lib/tool-host-release.test.mjs",
      "scripts/run-live-tool-host-release-check.mjs",
      "scripts/lib/owned-acceptance-cleanup.mjs",
      "scripts/run-live-workspace-transfer-check.mjs",
    ]),
  ).not.toThrow();
  expect(() =>
    assertOperatorRevisionChanges(["packages/control-plane/src/control-plane-quiescence.ts"]),
  ).toThrow();
});

it("keeps presentation acceptance helpers outside the deployed runtime boundary", () => {
  expect(() =>
    assertScopedSources("web", [
      "packages/web-ui/src/ConversationTimeline.tsx",
      "packages/web-ui/src/session-view.ts",
      "packages/web-ui/src/conversation-presentation.ts",
      "packages/web-ui/src/virtual-conversation-rows.ts",
      "packages/web-ui/src/composer-submission.ts",
      "packages/web-ui/src/submission-presentation.ts",
      "scripts/run-history-layout-check.mjs",
      "scripts/run-skill-market-browser-check.mjs",
      "scripts/run-live-skill-market-browser-check.mjs",
      "scripts/run-history-window-check.mjs",
      "scripts/run-live-android-check.mjs",
      "scripts/run-live-schedules-check.mjs",
    ]),
  ).not.toThrow();
  for (const file of [
    "packages/web-ui/src/api.ts",
    "packages/protocol/src/control-plane-api.ts",
    "scripts/unreviewed-runtime.mjs",
  ])
    expect(() => assertScopedSources("web", [file])).toThrow("matched release");
});

it("limits Tool host scope to ordinary tool implementations and one unchanged deployment template", () => {
  expect(() =>
    assertScopedSources("tool-host", [
      "packages/control-plane/src/ordinary-tools/new-tool.ts",
      "packages/control-plane/src/ordinary-tools/registry.ts",
    ]),
  ).not.toThrow();
  for (const file of [
    "packages/control-plane/src/main.ts",
    "packages/control-plane/src/session-runtime-main.ts",
    "packages/sandbox-control/src/sandbox-session-runtime.ts",
    "packages/control-plane/src/control-tool-dispatcher.ts",
    "packages/control-plane/src/control-plane.controller.ts",
    "packages/runtime-core/src/session-projector.ts",
    "packages/database/src/schema.ts",
    "package-lock.json",
    "deploy/provider-gateway/Dockerfile",
    "deploy/helm/pi-cloud-platform/files/model-catalog.json",
  ])
    expect(() => assertScopedSources("tool-host", [file])).toThrow("matched release");
  const before = structuredClone(provider);
  before.kind = "Deployment";
  before.metadata.name = "pi-cloud-tool-host";
  before.spec.template.spec.containers[0].name = "tool-host";
  const next = structuredClone(before);
  next.spec.template.spec.containers[0].image = "new";
  expect(() =>
    assertScopedManifests("tool-host", yaml(before, other), yaml(next, other), "new"),
  ).not.toThrow();
  next.spec.replicas = 0;
  expect(() =>
    assertScopedManifests("tool-host", yaml(before, other), yaml(next, other), "new"),
  ).toThrow();
});

it("fingerprints actual image COPY inputs including shared dependencies", () => {
  const files = [
    "package.json",
    "packages/control-plane/src/main.ts",
    "packages/protocol/src/index.ts",
    "packages/web-ui/src/App.tsx",
  ];
  expect(
    dockerSourceInputs(
      "Dockerfile",
      files,
      "COPY package.json ./\nCOPY packages/control-plane/src packages/control-plane/src\nCOPY packages/protocol/src packages/protocol/src\nCOPY --from=builder /app /app",
    ),
  ).toEqual([".dockerignore", "Dockerfile", ...files.slice(0, 3).sort()].sort());
  expect(() =>
    dockerSourceInputs("Dockerfile", files, "COPY private/secrets /run/secrets"),
  ).toThrow("Untracked");
});

it("records a new Tool-host role from one host artifact and retains management, metering and Worker/Cube provenance", () => {
  const baseline = {
    formatVersion: 1,
    revision: "old",
    contracts: { toolHostReplacement: 1, sessionRuntimeReplacement: 1 },
    components: {
      "control-plane": {
        imageId: "old",
        sourceRevision: "management-source",
        reference: "pi-cloud/control-plane:old",
      },
      "session-runtime": {
        imageId: "old",
        sourceRevision: "session-source",
        reference: "pi-cloud/control-plane:old",
      },
      "tool-host": {
        imageId: "old",
        sourceRevision: "runtime-source",
        reference: "pi-cloud/control-plane:old",
      },
      metering: {
        imageId: "old",
        sourceRevision: "metering-source",
        reference: "pi-cloud/control-plane:old",
      },
      "supervisor-host": { sourceRevision: "worker", imageId: "worker" },
      cubelet: { sourceRevision: "cube", imageId: "cube" },
    },
  };
  const evidence = {
    images: [
      {
        reference: "pi-cloud/control-plane:new",
        imageId: "new",
        repoDigests: [],
        provenance: { sourceRevision: "new" },
        policyVulnerabilities: { HIGH: { fixable: 0 }, CRITICAL: { fixable: 0 } },
      },
    ],
  };
  const next = composeScopedDeployment(baseline, {
    scope: "tool-host",
    revision: "new",
    version: "new",
    evidence,
    evidenceDirectory: "evidence",
  });
  expect(next.components["supervisor-host"]).toEqual(baseline.components["supervisor-host"]);
  expect(next.components.cubelet).toEqual(baseline.components.cubelet);
  expect(next.components["tool-host"].imageId).toBe("new");
  expect(next.components["tool-host"].sourceRevision).toBe("new");
  expect(next.components["control-plane"]).toEqual(baseline.components["control-plane"]);
  expect(next.components.metering).toEqual(baseline.components.metering);
  expect(next.contracts).toEqual(baseline.contracts);
  const incomplete = structuredClone(baseline);
  delete incomplete.components.metering;
  expect(() =>
    composeScopedDeployment(incomplete, {
      scope: "tool-host",
      revision: "new",
      version: "new",
      evidence,
      evidenceDirectory: "evidence",
    }),
  ).toThrow("matched role manifest");
});

it("accepts only the provider image difference and rejects side effects on data or other workloads", () => {
  const next = structuredClone(provider);
  next.spec.template.spec.containers[0].image = "new";
  expect(() =>
    assertScopedManifests("provider", yaml(provider, other), yaml(next, other), "new"),
  ).not.toThrow();
  for (const change of [
    (v) => v.spec.replicas++,
    (v) => (v.spec.template.spec.volumes[0].persistentVolumeClaim.claimName = "other"),
    (v) => v.spec.template.spec.containers.push({ name: "another", image: "new" }),
  ]) {
    const bad = structuredClone(next);
    change(bad);
    expect(() =>
      assertScopedManifests("provider", yaml(provider, other), yaml(bad, other), "new"),
    ).toThrow();
  }
  expect(() =>
    assertScopedManifests("provider", yaml(provider, other), yaml(next), "new"),
  ).toThrow();
});
it("normalizes only equivalent provider integer environment spelling", () => {
  const before = structuredClone(provider);
  before.spec.template.spec.containers[0].env = [
    { name: "PI_CLOUD_MODEL_REQUEST_MAX_BYTES", value: "2.68435456e+08" },
    { name: "OTHER", value: "1e2" },
  ];
  const after = structuredClone(before);
  after.spec.template.spec.containers[0].image = "new";
  after.spec.template.spec.containers[0].env[0].value = "268435456";
  expect(() =>
    assertScopedManifests("provider", yaml(before, other), yaml(after, other), "new"),
  ).not.toThrow();
  for (const change of [
    (v) => (v.spec.template.spec.containers[0].env[0].value = "536870912"),
    (v) => (v.spec.template.spec.containers[0].env[1].value = "100"),
    (v) => v.spec.template.spec.containers[0].env.push({ name: "NEW", value: "1" }),
  ]) {
    const bad = structuredClone(after);
    change(bad);
    expect(() =>
      assertScopedManifests("provider", yaml(before, other), yaml(bad, other), "new"),
    ).toThrow();
  }
});

it("catalog publishing changes only its JSON, with unrelated resource changes refused", () => {
  const before = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: "pi-cloud-model-catalog" },
    data: { "model-catalog.json": '{"old":true}\n' },
  };
  const next = structuredClone(before);
  next.data["model-catalog.json"] = '{ "new": true }\n';
  expect(() =>
    assertScopedManifests("catalog", yaml(before, other), yaml(next, other), '{"new":true}'),
  ).not.toThrow();
  next.metadata.labels = { added: "unexpected" };
  expect(() =>
    assertScopedManifests("catalog", yaml(before), yaml(next), '{"new":true}'),
  ).toThrow();
});
it("Web presentation releases cannot alter the API, proxy, dependencies or other images", () => {
  expect(() =>
    assertScopedSources("web", [
      "packages/web-ui/src/RunStatus.tsx",
      "packages/web-ui/src/product.css",
      "scripts/production-kubernetes.mjs",
      "scripts/run-browser-presentation-check.mjs",
      "scripts/run-browser-queue-check.mjs",
      "scripts/run-live-queue-input-check.mjs",
      "scripts/run-live-release-acceptance.mjs",
      "scripts/run-live-review-repair-check.mjs",
      "scripts/run-live-development-environment-check.mjs",
      "scripts/run-live-missing-directory-check.mjs",
      "AGENTS.md",
    ]),
  ).not.toThrow();
  for (const file of [
    "packages/protocol/src/run-observation.ts",
    "packages/web-ui/src/api.ts",
    "packages/web-ui/Caddyfile",
    "packages/web-ui/Dockerfile",
    "package-lock.json",
    "deploy/helm/pi-cloud-platform/templates/web.yaml",
    "deploy/provider-gateway/Dockerfile",
    "deploy/helm/pi-cloud-platform/files/model-catalog.json",
  ])
    expect(() => assertScopedSources("web", [file])).toThrow("matched release");
  expect(() => assertScopedSources("provider", ["packages/web-ui/src/RunStatus.tsx"])).toThrow();
  const web = structuredClone(provider);
  web.kind = "Deployment";
  web.metadata.name = "pi-cloud-web";
  web.spec.template.spec.containers[0].name = "web";
  const next = structuredClone(web);
  next.spec.template.spec.containers[0].image = "new";
  expect(() =>
    assertScopedManifests("web", yaml(web, provider, other), yaml(next, provider, other), "new"),
  ).not.toThrow();
  for (const change of [
    (v) => v.spec.replicas++,
    (v) => (v.spec.template.spec.containers[0].env = [{ name: "UPSTREAM", value: "other" }]),
    (v) => (v.spec.template.spec.volumes = []),
  ]) {
    const bad = structuredClone(next);
    change(bad);
    expect(() =>
      assertScopedManifests("web", yaml(web, provider), yaml(bad, provider), "new"),
    ).toThrow();
  }
  const changedWorker = structuredClone(other);
  changedWorker.spec.replicas++;
  expect(() =>
    assertScopedManifests("web", yaml(web, other), yaml(next, changedWorker), "new"),
  ).toThrow();
});
it("excludes source/protocol changes from a narrow release", () => {
  expect(() =>
    assertScopedSources("provider", [
      "deploy/provider-gateway/Dockerfile",
      "docs/README.md",
      "scripts/run-component-release.mjs",
    ]),
  ).not.toThrow();
  for (const file of [
    "packages/protocol/src/supervisor-wire.ts",
    "package-lock.json",
    "deploy/helm/pi-cloud-platform/templates/control-plane.yaml",
  ])
    expect(() => assertScopedSources("provider", [file])).toThrow("matched release");
});
it("retains old component provenance and enforces the new image gate", () => {
  const baseline = {
    formatVersion: 1,
    revision: "old",
    catalogRevision: "catalog",
    components: {
      worker: { sourceRevision: "old", imageId: "old-digest" },
      "cli-proxy-api": { imageId: "old" },
    },
    contracts: { schema: 196 },
  };
  const evidence = {
    images: [
      {
        reference: "pi-cloud/cli-proxy-api:new",
        imageId: "new-digest",
        repoDigests: [],
        provenance: { sourceRevision: "new" },
        policyVulnerabilities: { HIGH: { fixable: 0 }, CRITICAL: { fixable: 0 } },
      },
    ],
  };
  const next = composeScopedDeployment(baseline, {
    scope: "provider",
    version: "new",
    revision: "new",
    evidence,
    evidenceDirectory: "evidence",
  });
  expect(next.components.worker).toEqual(baseline.components.worker);
  expect(next.components["cli-proxy-api"].sourceRevision).toBe("new");
  expect(next.contracts).toEqual(baseline.contracts);
  expect(baseline.components["cli-proxy-api"].imageId).toBe("old");
  evidence.images[0].policyVulnerabilities.HIGH.fixable = 1;
  expect(() => composeScopedDeployment(baseline, { scope: "provider", evidence })).toThrow(
    "scan failed",
  );
});
it("updates only Web provenance and rejects provider evidence for Web publication", () => {
  const baseline = {
    formatVersion: 1,
    revision: "old",
    catalogRevision: "catalog",
    contracts: { schema: 196 },
    components: {
      "web-ui": { imageId: "old" },
      "cli-proxy-api": { imageId: "provider" },
      worker: { imageId: "worker" },
    },
  };
  const evidence = {
    images: [
      {
        reference: "pi-cloud/web-ui:new",
        imageId: "new",
        repoDigests: [],
        provenance: { sourceRevision: "new" },
        policyVulnerabilities: { HIGH: { fixable: 0 }, CRITICAL: { fixable: 0 } },
      },
    ],
  };
  const next = composeScopedDeployment(baseline, {
    scope: "web",
    version: "new",
    revision: "new",
    evidence,
    evidenceDirectory: "evidence",
  });
  expect(next.components["web-ui"].sourceRevision).toBe("new");
  expect(next.components.worker).toEqual(baseline.components.worker);
  expect(next.components["cli-proxy-api"]).toEqual(baseline.components["cli-proxy-api"]);
  expect(next.contracts).toEqual(baseline.contracts);
  expect(next.catalogRevision).toBe("catalog");
  evidence.images[0].reference = "pi-cloud/cli-proxy-api:new";
  expect(() => composeScopedDeployment(baseline, { scope: "web", evidence })).toThrow();
});

it("rejects stale baselines and finishes recording a confirmed Helm apply after a lost local write", () => {
  const baseline = { version: "one" },
    next = { version: "two" };
  const context = {
    baseline,
    next,
    current: baseline,
    helmRevision: 4,
    before: "old",
    desired: "new",
    live: { manifest: "old", status: { version: 4 } },
  };
  expect(scopedApplyState(context)).toBe("apply");
  expect(() => scopedApplyState({ ...context, current: { version: "other" } })).toThrow("baseline");
  expect(() =>
    scopedApplyState({ ...context, live: { manifest: "old", status: { version: 5 } } }),
  ).toThrow("baseline");
  expect(() =>
    scopedApplyState({ ...context, live: { manifest: "unexpected", status: { version: 4 } } }),
  ).toThrow("resources");
  expect(scopedApplyState({ ...context, live: { manifest: "new", status: { version: 5 } } })).toBe(
    "verify",
  );
  expect(
    scopedApplyState({
      ...context,
      current: next,
      live: { manifest: "new", status: { version: 5 } },
    }),
  ).toBe("verify");
});

it("retains prepared artifacts across operator-only fixes, excluding changed runtime inputs", () => {
  expect(() =>
    assertOperatorRevisionChanges([
      "scripts/run-component-release.mjs",
      "docs/README.md",
      "scripts/lib/component-release.test.mjs",
    ]),
  ).not.toThrow();
  for (const file of [
    "deploy/provider-gateway/Dockerfile",
    "package-lock.json",
    "packages/control-plane/src/main.ts",
    "deploy/helm/pi-cloud-platform/files/model-catalog.json",
  ])
    expect(() => assertOperatorRevisionChanges([file])).toThrow("runtime inputs changed");
});
it("passes two Helm positional arguments and preserves paths as individual argv values", () => {
  const input = {
    name: "pi-cloud",
    chart: "/private/path with spaces/chart",
    values: "/private/values file.yaml",
    kubeconfig: "/private/kubeconfig",
    namespace: "cube-system",
  };
  const args = scopedHelmUpgradeArguments(input);
  expect(args.slice(0, 3)).toEqual(["upgrade", input.name, input.chart]);
  expect(args[args.indexOf("--values") + 1]).toBe(input.values);
  expect(args.slice(args.indexOf("--namespace"))).toEqual(["--namespace", "cube-system"]);
  expect(args).toContain("--no-hooks");
  expect(() =>
    scopedHelmUpgradeArguments({ ...input, namespace: () => "accidental function" }),
  ).toThrow("arguments");
});

function sharedHostDeployment(role, image = "pi-cloud/control-plane:old") {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: `pi-cloud-${role}` },
    spec: {
      replicas: 1,
      template: {
        spec: {
          containers: [
            {
              name: role,
              image,
              args: [
                `/app/packages/${role === "metering" ? "accounting/src/main" : `control-plane/src/${role === "tool-host" ? "tool-host-main" : "main"}`}.ts`,
              ],
            },
          ],
        },
      },
    },
  };
}

it("changes only images.toolHost even when four roles share the same built image", () => {
  const values = {
    images: {
      controlPlane: {
        repository: "pi-cloud/control-plane",
        tag: "old",
        pullPolicy: "IfNotPresent",
      },
      sessionRuntime: {
        repository: "pi-cloud/control-plane",
        tag: "old",
        pullPolicy: "IfNotPresent",
      },
      toolHost: {
        repository: "pi-cloud/control-plane",
        tag: "old",
        digest: "sha256:old",
        pullPolicy: "IfNotPresent",
      },
      metering: { repository: "pi-cloud/control-plane", tag: "old", pullPolicy: "IfNotPresent" },
    },
  };
  const next = scopedImageValues("tool-host", values, "pi-cloud/control-plane:new", "new");
  expect(next.images.toolHost).toEqual({
    repository: "pi-cloud/control-plane",
    tag: "new",
    pullPolicy: "IfNotPresent",
  });
  expect(next.images.controlPlane).toEqual(values.images.controlPlane);
  expect(next.images.metering).toEqual(values.images.metering);
  expect(next.images.sessionRuntime).toEqual(values.images.sessionRuntime);
  expect(values.images.toolHost.tag).toBe("old");
  expect(() =>
    scopedImageValues("control-plane", values, "pi-cloud/control-plane:new", "new"),
  ).toThrow("Unknown");
  expect(() => assertScopedSources("control-plane", [])).toThrow("Unknown");
});

it("requires the ordinary Tool host as the only manifest target", () => {
  const management = sharedHostDeployment("control-plane"),
    runtime = sharedHostDeployment("tool-host"),
    metering = sharedHostDeployment("metering");
  const next = structuredClone(runtime);
  next.spec.template.spec.containers[0].image = "pi-cloud/control-plane:new";
  expect(() =>
    assertScopedManifests(
      "tool-host",
      yaml(management, runtime, metering),
      yaml(management, next, metering),
      "pi-cloud/control-plane:new",
    ),
  ).not.toThrow();
  for (const role of ["control-plane", "metering"]) {
    const changed = sharedHostDeployment(role, "pi-cloud/control-plane:new");
    expect(() =>
      assertScopedManifests(
        "tool-host",
        yaml(management, runtime, metering),
        yaml(
          role === "control-plane" ? changed : management,
          next,
          role === "metering" ? changed : metering,
        ),
        "pi-cloud/control-plane:new",
      ),
    ).toThrow("Unexpected resource change");
  }
  const startup = structuredClone(next);
  startup.spec.template.spec.containers[0].args = ["/app/packages/control-plane/src/main.ts"];
  expect(() =>
    assertScopedManifests(
      "tool-host",
      yaml(management, runtime, metering),
      yaml(management, startup, metering),
      "pi-cloud/control-plane:new",
    ),
  ).toThrow();
});

it("expands one scanned artifact to independent role provenance without extra builds", () => {
  const evidence = {
    images: [
      {
        reference: "pi-cloud/control-plane:full",
        imageId: "sha256:one",
        repoDigests: ["pi-cloud/control-plane@sha256:one"],
        provenance: { sourceRevision: "source" },
      },
    ],
  };
  const record = deploymentFromEvidence({
    evidence,
    evidenceDirectory: "evidence",
    revision: "source",
    version: "full",
  });
  expect(Object.keys(record.components).sort()).toEqual([
    "control-plane",
    "metering",
    "session-runtime",
    "tool-host",
  ]);
  for (const component of Object.values(record.components))
    expect(component).toMatchObject({
      imageId: "sha256:one",
      sourceRevision: "source",
      reference: "pi-cloud/control-plane:full",
    });
  expect(evidence.images).toHaveLength(1);
});

it("detects live management/metering drift even when the expected shared image is still present elsewhere", () => {
  const deployment = {
    components: Object.fromEntries(
      ["control-plane", "session-runtime", "tool-host", "metering"].map((role) => [
        role,
        { reference: "pi-cloud/control-plane:old" },
      ]),
    ),
  };
  const alternative = { name: "tool-host", reference: "pi-cloud/control-plane:new" };
  const resources = [
    sharedHostDeployment("control-plane"),
    sharedHostDeployment("tool-host", alternative.reference),
    sharedHostDeployment("metering"),
    sharedHostDeployment("session-runtime"),
  ];
  expect(() => assertServingComponents(deployment, resources, alternative)).not.toThrow();
  for (const index of [0, 2]) {
    const changed = structuredClone(resources);
    changed[index].spec.template.spec.containers[0].image = alternative.reference;
    expect(() => assertServingComponents(deployment, changed, alternative)).toThrow(
      "Serving role differs",
    );
  }
});

it("limits decoder repair to the installed envelope and only the Session runtime image", () => {
  assertScopedSources("session-decoder", ["packages/runtime-core/src/session-log-envelope.ts"]);
  for (const file of [
    "packages/protocol/src/tool-broker.ts",
    "packages/runtime-core/src/session-projector.ts",
    "packages/control-plane/src/session-runtime-main.ts",
    "packages/control-plane/src/ordinary-tools/registry.ts",
    "packages/database/src/schema.ts",
  ])
    expect(() => assertScopedSources("session-decoder", [file])).toThrow("matched release");
  expect(() =>
    assertScopedSources("tool-host", ["packages/runtime-core/src/session-log-envelope.ts"]),
  ).toThrow("matched release");
  const roles = ["control-plane", "session-runtime", "tool-host", "metering"];
  const old = roles.map((role) => sharedHostDeployment(role));
  const next = old.map((r) => structuredClone(r));
  next[1].spec.template.spec.containers[0].image = "pi-cloud/control-plane:new";
  assertScopedManifests(
    "session-decoder",
    yaml(...old),
    yaml(...next),
    "pi-cloud/control-plane:new",
  );
  next[2].spec.template.spec.containers[0].image = "pi-cloud/control-plane:new";
  expect(() =>
    assertScopedManifests(
      "session-decoder",
      yaml(...old),
      yaml(...next),
      "pi-cloud/control-plane:new",
    ),
  ).toThrow("Unexpected resource change");
  const values = {
    images: Object.fromEntries(
      ["controlPlane", "sessionRuntime", "toolHost", "metering"].map((key) => [
        key,
        { repository: "pi-cloud/control-plane", tag: "old" },
      ]),
    ),
  };
  const updated = scopedImageValues("session-decoder", values, "pi-cloud/control-plane:new", "new");
  expect(updated.images.sessionRuntime.tag).toBe("new");
  for (const key of ["controlPlane", "toolHost", "metering"])
    expect(updated.images[key]).toEqual(values.images[key]);
});
