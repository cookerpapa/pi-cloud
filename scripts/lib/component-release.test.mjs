import { expect, it } from "vitest";
import { stringify } from "yaml";
import {
  assertScopedSources,
  assertOperatorRevisionChanges,
  scopedHelmUpgradeArguments,
  assertScopedManifests,
  composeScopedDeployment,
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

it("accepts operator-only replacement repairs without relabeling the prepared runtime", () => {
  expect(() =>
    assertOperatorRevisionChanges([
      "scripts/lib/control-plane-release.mjs",
      "scripts/lib/control-plane-release.test.mjs",
      "scripts/run-live-control-plane-release-check.mjs",
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
      "scripts/run-history-layout-check.mjs",
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

it("limits Control Plane scope to ordinary tool implementations and one unchanged deployment template", () => {
  expect(() =>
    assertScopedSources("control-plane", [
      "packages/control-plane/src/ordinary-tools/new-tool.ts",
      "packages/control-plane/src/ordinary-tools/registry.ts",
    ]),
  ).not.toThrow();
  for (const file of [
    "packages/control-plane/src/main.ts",
    "packages/control-plane/src/control-tool-dispatcher.ts",
    "packages/control-plane/src/control-plane.controller.ts",
    "packages/runtime-core/src/session-projector.ts",
    "packages/database/src/schema.ts",
    "package-lock.json",
    "deploy/provider-gateway/Dockerfile",
    "deploy/helm/pi-cloud-platform/files/model-catalog.json",
  ])
    expect(() => assertScopedSources("control-plane", [file])).toThrow("matched release");
  const before = structuredClone(provider);
  before.kind = "Deployment";
  before.metadata.name = "pi-cloud-control-plane";
  before.spec.template.spec.containers[0].name = "control-plane";
  const next = structuredClone(before);
  next.spec.template.spec.containers[0].image = "new";
  expect(() =>
    assertScopedManifests("control-plane", yaml(before, other), yaml(next, other), "new"),
  ).not.toThrow();
  next.spec.replicas = 0;
  expect(() =>
    assertScopedManifests("control-plane", yaml(before, other), yaml(next, other), "new"),
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

it("records one new Control Plane artifact and retains Worker/Cube provenance", () => {
  const baseline = {
    formatVersion: 1,
    revision: "old",
    contracts: { controlPlaneReplacement: 1 },
    components: {
      "control-plane": { imageId: "old" },
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
    scope: "control-plane",
    revision: "new",
    version: "new",
    evidence,
    evidenceDirectory: "evidence",
  });
  expect(next.components["supervisor-host"]).toEqual(baseline.components["supervisor-host"]);
  expect(next.components.cubelet).toEqual(baseline.components.cubelet);
  expect(next.components["control-plane"].imageId).toBe("new");
  expect(next.contracts).toEqual(baseline.contracts);
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
