import { expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { parseAllDocuments } from "yaml";
import {
  cubeReleaseValues,
  pinCubeReleaseValues,
  cubeReleaseDigest,
  cubeCredentialData,
  cubeNewCredentialData,
  assertCubeCredentialsRetained,
} from "./cube-release-policy.mjs";

it("lets the fixed TemplateCenter resolve image layers from the private registry", async () => {
  const resources = parseAllDocuments(
    await readFile(
      new URL("../../deploy/cubesandbox/template-registry.yaml", import.meta.url),
      "utf8",
    ),
  ).map((document) => document.toJS());
  const policy = resources.find((resource) => resource.kind === "NetworkPolicy");
  const peers = policy.spec.ingress.flatMap((rule) => rule.from);
  for (const component of ["master", "templatecenter"])
    expect(peers).toContainEqual({
      podSelector: { matchLabels: { "app.kubernetes.io/component": component } },
    });
  expect(
    policy.spec.ingress.every(
      (rule) =>
        rule.ports.length === 1 && rule.ports[0].port === 5000 && rule.ports[0].protocol === "TCP",
    ),
  ).toBe(true);
  expect(policy.spec.egress).toEqual([]);
});

it("adopts v0.7.3 defaults without losing explicit configuration or adding a second store", () => {
  const old = {
    images: {
      master: { repository: "pi-cloud/cube-master", tag: "old" },
      networkAgent: { repository: "retired/network-agent", tag: "v0.6.0" },
    },
    mysql: { password: "fixture-only-secret" },
    controlPlane: {
      master: {
        persistence: { existingClaim: "retained-artifacts" },
        env: [{ name: "KEPT", value: "yes" }],
      },
    },
    cubeNode: { network: { cidr: "172.16.0.0/18" } },
    cubeOps: { enabled: false },
  };
  const next = cubeReleaseValues(old, "0.7.3", "matched-v073");
  expect(next.mysql).toEqual(old.mysql);
  expect(next.controlPlane.master).toEqual(old.controlPlane.master);
  expect(next.cubeNode).toEqual({ ...old.cubeNode, hostNetwork: false });
  expect(next.cubeOps.enabled).toBe(true);
  expect(next.controlPlane.artifactStore).toMatchObject({ backend: "fs", s3Backed: false });
  expect(next.minio.enabled).toBe(false);
  expect(next.cubeS3lvol.enabled).toBe(false);
  expect(next.images.templateCenter).toMatchObject({
    repository: "pi-cloud/cube-templatecenter",
    tag: "matched-v073",
  });
  expect(next.images.cubeAgent.tag).toBe("v0.7.3");
  expect(next.images.proxy.tag).toBe("v0.7.3");
  expect(next.images.networkAgent).toBeUndefined();
  expect(old.images.master.tag).toBe("old");
  expect(() => cubeReleaseValues(old, "0.7.4", "candidate")).toThrow("Review");
});

it("writes digest pins only for actual image inputs, without freezing unrelated new defaults", () => {
  const digest = "a".repeat(64);
  const explicit = {
    images: { master: { repository: "pi-cloud/cube-master", tag: "candidate" } },
    mysql: { password: "preserved" },
  };
  const defaults = {
    newFeature: { enabled: true },
    mysql: { image: { repository: "mysql", tag: "8.0", pullPolicy: "IfNotPresent" } },
    images: {
      cubeGuest: {
        repository: "cube-sandbox-int.tencentcloudcr.com/cube-sandbox/cube-guest",
        tag: "v0.7.3",
      },
    },
  };
  const next = pinCubeReleaseValues(explicit, defaults, {
    images: [
      { reference: "mysql:8.0", pinnedReference: `docker.io/library/mysql@sha256:${digest}` },
      {
        reference: "cube-sandbox-int.tencentcloudcr.com/cube-sandbox/cube-guest:v0.7.3",
        pinnedReference: `cube-sandbox-int.tencentcloudcr.com/cube-sandbox/cube-guest@sha256:${digest}`,
      },
    ],
  });
  expect(next.mysql.image.repository + ":" + next.mysql.image.tag).toBe(
    `docker.io/library/mysql@sha256:${digest}`,
  );
  expect(next.mysql.password).toBe("preserved");
  expect(next.newFeature).toBeUndefined();
  expect(next.images.master).toEqual(explicit.images.master);
  expect(next.images.cubeGuest.repository + ":" + next.images.cubeGuest.tag).toContain("@sha256:");
});

it("preserves native credential bytes and records only newly introduced callback credentials", () => {
  const previous = { "cube-secret": { "redis-password": "b2xk" } };
  const next = cubeCredentialData([
    {
      kind: "Secret",
      metadata: { name: "cube-secret" },
      stringData: { "redis-password": "old", "cube-template-callback-token": "new-callback" },
    },
  ]);
  expect(() => assertCubeCredentialsRetained(previous, next)).not.toThrow();
  expect(cubeNewCredentialData(previous, next)).toEqual({
    "cube-secret": {
      "cube-template-callback-token": Buffer.from("new-callback").toString("base64"),
    },
  });
  let failure;
  try {
    assertCubeCredentialsRetained(previous, {
      "cube-secret": { "redis-password": "NEVER_PRINT_THIS" },
    });
  } catch (error) {
    failure = error;
  }
  expect(failure.message).toContain("Existing Cube credential changed");
  expect(JSON.stringify(failure)).not.toContain("NEVER_PRINT_THIS");
  expect(failure.actual).toBeUndefined();
  expect(failure.expected).toBeUndefined();
});

it("hashes binary CLI contents directly and makes value-map order immaterial", () => {
  expect(cubeReleaseDigest(Buffer.from("fixture"))).toBe(cubeReleaseDigest("fixture"));
  expect(cubeReleaseDigest({ b: 1, a: 2 })).toBe(cubeReleaseDigest({ a: 2, b: 1 }));
});
