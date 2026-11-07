import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parseAllDocuments } from "yaml";
import { assertCubeWorkspaceContract } from "./cube-workspace-contract.mjs";

const canonical = (value) =>
  Array.isArray(value)
    ? value.map(canonical)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, child]) => [key, canonical(child)]),
        )
      : value;
export const cubeReleaseDigest = (value) =>
  createHash("sha256")
    .update(
      typeof value === "string" || value instanceof Uint8Array
        ? value
        : JSON.stringify(canonical(value)),
    )
    .digest("hex");
export const cubeNativeImages = {
  api: "cube-api",
  master: "cube-master",
  templateCenter: "cube-templatecenter",
  cubelet: "cubelet",
};
const official = {
  pvmHostBootstrap: "cube-pvm-host-bootstrap",
  nodeInit: "cube-node-init",
  waitNodePrep: "cube-wait-node-prep",
  cubeShim: "cube-shim",
  cubeKernel: "cube-kernel",
  cubeGuest: "cube-guest",
  cubeAgent: "cube-agent",
  ops: "cube-ops",
  cubemastercli: "cubemastercli",
  proxy: "cube-proxy",
  lifecycleManager: "cube-lifecycle-manager",
  cubeEgress: "cube-egress",
  cubeEgressNet: "cube-egress-net",
  cubeS3lvol: "cube-s3lvol",
  webui: "cube-webui",
};
/** New chart defaults plus preserved explicit operator values; no old defaults. */
export function cubeReleaseValues(explicit, upstreamVersion, tag) {
  assert.equal(upstreamVersion, "0.7.3", "Review the native closure for another Cube version");
  if (tag !== undefined) assert.match(tag, /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/);
  const values = structuredClone(explicit ?? {});
  values.images ??= {};
  delete values.images.networkAgent;
  for (const [key, image] of Object.entries(official))
    values.images[key] = {
      ...values.images[key],
      repository: `cube-sandbox-int.tencentcloudcr.com/cube-sandbox/${image}`,
      tag: `v${upstreamVersion}`,
    };
  for (const [key, image] of Object.entries(cubeNativeImages)) {
    if (tag) values.images[key] = { ...values.images[key], repository: `pi-cloud/${image}`, tag };
    assert.equal(
      values.images[key]?.repository,
      `pi-cloud/${image}`,
      "Install the complete matched native release first",
    );
    assert(values.images[key].tag, "Missing custom native image identity");
  }
  values.minio = { ...values.minio, enabled: false };
  values.cubeS3lvol = { ...values.cubeS3lvol, enabled: false };
  values.cubeOps = { ...values.cubeOps, enabled: true };
  values.cubeNode = { ...values.cubeNode, hostNetwork: false };
  values.controlPlane ??= {};
  values.controlPlane.artifactStore = {
    ...values.controlPlane.artifactStore,
    backend: "fs",
    s3Backed: false,
  };
  const tc = values.controlPlane.templateCenter ?? {};
  const env = [
    ...(tc.env ?? []).filter((entry) => entry.name !== "SSL_CERT_FILE"),
    { name: "SSL_CERT_FILE", value: "/etc/cube/ca/cube-root-ca.crt" },
  ];
  values.controlPlane.templateCenter = { ...tc, colocateWithMaster: true, replicas: 1, env };
  return values;
}
export function cubeResources(yaml) {
  return parseAllDocuments(yaml, { version: "1.1" })
    .map((document) => {
      assert.equal(document.errors.length, 0, "Invalid private Cube manifest");
      return document.toJS();
    })
    .filter(Boolean);
}
export function cubeSecretData(resource) {
  return {
    ...resource.data,
    ...Object.fromEntries(
      Object.entries(resource.stringData ?? {}).map(([key, value]) => [
        key,
        Buffer.from(value).toString("base64"),
      ]),
    ),
  };
}
/** Configuration bodies may change, but existing credential bytes never rotate. */
export function cubeCredentialData(resources) {
  return Object.fromEntries(
    resources
      .filter(
        (resource) =>
          resource.kind === "Secret" &&
          !resource.metadata.name.endsWith("-config") &&
          resource.metadata.name !== "pi-cloud-cube-completion",
      )
      .map((resource) => [resource.metadata.name, cubeSecretData(resource)]),
  );
}
export function assertCubeCredentialsRetained(previous, next) {
  for (const [name, fields] of Object.entries(previous))
    for (const [key, value] of Object.entries(fields))
      if (next[name]?.[key] !== value)
        throw new Error(`Existing Cube credential changed: ${name}/${key}`);
}
export function cubeNewCredentialData(previous, next) {
  return Object.fromEntries(
    Object.entries(next)
      .map(([name, fields]) => [
        name,
        Object.fromEntries(
          Object.entries(fields).filter(([key]) => previous[name]?.[key] === undefined),
        ),
      ])
      .filter(([, fields]) => Object.keys(fields).length),
  );
}
const workload = (resources, kind, name) => {
  const matches = resources.filter(
    (resource) => resource.kind === kind && resource.metadata.name === name,
  );
  assert.equal(matches.length, 1, `Missing native ${kind}/${name}`);
  return matches[0];
};
function artifactVolume(resource, containerName) {
  const pod = resource.spec.template.spec;
  const target = pod.containers.find((container) => container.name === containerName);
  const mount = target?.volumeMounts?.find(
    (mount) => mount.mountPath === "/data/CubeMaster/storage",
  );
  const volume = pod.volumes?.find((volume) => volume.name === mount?.name);
  assert(
    volume?.persistentVolumeClaim || volume?.hostPath,
    "Template artifacts require the retained persistent Master volume",
  );
  return volume.persistentVolumeClaim
    ? { claimName: volume.persistentVolumeClaim.claimName }
    : { hostPath: volume.hostPath.path };
}
export function assertCubeReleaseManifest(resources, { sharedRoot, tag, priorResources }) {
  const master = workload(resources, "Deployment", "cube-master"),
    tc = workload(resources, "Deployment", "cube-templatecenter"),
    node = workload(resources, "DaemonSet", "cube-node");
  workload(resources, "Deployment", "cube-ops");
  assertCubeWorkspaceContract(master, node, sharedRoot);
  assert.equal(
    node.spec.template.spec.hostNetwork,
    false,
    "Native upgrade changed Pod-network isolation",
  );
  assert(
    !node.spec.template.spec.containers.some((container) =>
      ["network-agent", "cube-s3lvol"].includes(container.name),
    ),
  );
  assert(
    !resources.some(
      (resource) =>
        ["StatefulSet", "Deployment", "Service", "PersistentVolumeClaim"].includes(resource.kind) &&
        /minio/.test(resource.metadata.name),
    ),
    "Native upgrade introduced MinIO",
  );
  assert.deepEqual(
    artifactVolume(tc, "cube-templatecenter"),
    artifactVolume(master, "cube-master"),
  );
  if (priorResources?.length)
    assert.deepEqual(
      artifactVolume(master, "cube-master"),
      artifactVolume(workload(priorResources, "Deployment", "cube-master"), "cube-master"),
      "Master artifact storage changed",
    );
  for (const [resource, name, image] of [
    [master, "cube-master", "cube-master"],
    [tc, "cube-templatecenter", "cube-templatecenter"],
    [node, "cubelet", "cubelet"],
    [workload(resources, "Deployment", "cube-api"), "cube-api", "cube-api"],
  ]) {
    const container = resource.spec.template.spec.containers.find(
      (container) => container.name === name,
    );
    assert(container, `Missing native container ${name}`);
    if (tag) assert.equal(container.image, `pi-cloud/${image}:${tag}`);
  }
  for (const [resource, name] of [
    [master, "cube-master"],
    [tc, "cube-templatecenter"],
  ]) {
    const env = resource.spec.template.spec.containers.find(
      (container) => container.name === name,
    ).env;
    assert.equal(
      env.filter((entry) => entry.name === "CUBE_ARTIFACT_STORE_BACKEND").at(-1)?.value,
      "fs",
    );
  }
}

/** Pin only selected image fields, never promote old defaults into overrides. */
export function pinCubeReleaseValues(explicit, defaults, evidence) {
  const pins = new Map(evidence.images.map((image) => [image.reference, image.pinnedReference]));
  const merge = (base, overlay) => {
    if (
      !base ||
      typeof base !== "object" ||
      Array.isArray(base) ||
      !overlay ||
      typeof overlay !== "object" ||
      Array.isArray(overlay)
    )
      return structuredClone(overlay === undefined ? base : overlay);
    const value = structuredClone(base);
    for (const [key, entry] of Object.entries(overlay))
      value[key] = key in base ? merge(base[key], entry) : structuredClone(entry);
    return value;
  };
  const combined = merge(defaults, explicit),
    result = structuredClone(explicit);
  const set = (path, value) => {
    let target = result;
    for (const key of path.slice(0, -1)) target = target[key] ??= {};
    target[path.at(-1)] = value;
  };
  const visit = (value, path = []) => {
    if (!value || typeof value !== "object") return;
    if (typeof value.repository === "string" && typeof value.tag === "string") {
      let repository = value.repository;
      const override = combined.global?.imageRegistry;
      if (override && /^cube-sandbox-(?:int|cn)\.tencentcloudcr\.com\//.test(repository))
        repository = override.replace(/\/$/, "") + repository.slice(repository.indexOf("/"));
      const pin = pins.get(`${repository}:${value.tag}`);
      if (pin) {
        assert.match(pin, /^.+@sha256:[0-9a-f]{64}$/);
        const split = pin.lastIndexOf(":");
        set(path, { ...value, repository: pin.slice(0, split), tag: pin.slice(split + 1) });
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (key === "image" && typeof child === "string" && pins.has(child))
        set([...path, key], pins.get(child));
      else visit(child, [...path, key]);
    }
  };
  visit(combined);
  return result;
}
