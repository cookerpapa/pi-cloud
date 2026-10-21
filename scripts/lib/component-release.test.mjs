import { expect, it } from "vitest";
import { stringify } from "yaml";
import {
  assertScopedSources,
  assertScopedManifests,
  composeScopedDeployment,
  scopedApplyState,
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
