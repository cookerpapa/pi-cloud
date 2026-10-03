import { createHash } from "node:crypto";
import { parse, parseAllDocuments, stringify } from "yaml";
import {
  cubeCompletionPatch,
  cubeCompletionSecret,
  withCubeExecutionCompletion,
} from "./cube-execution-deployment.mjs";

export const CUBE_PLUGIN_CONFIG = "pi-cloud-posix-volume-plugin";
const plugin = "picloud-posix";
const hash = (value) => createHash("sha256").update(value).digest("hex");
function upsert(items, value) {
  const index = items.findIndex((item) => item.name === value.name);
  if (index < 0) items.push(value);
  else items[index] = { ...items[index], ...value };
}
function container(pod, name) {
  const result = pod.containers?.find((item) => item.name === name);
  if (!result) throw new Error(`Pinned Cube manifest lacks ${name}`);
  return result;
}
function mount(pod, name, value) {
  const target = container(pod, name);
  upsert((target.volumeMounts ??= []), value);
}
function annotate(resource, annotations) {
  const metadata = resource.spec.template.metadata;
  metadata.annotations = { ...metadata.annotations, ...annotations };
}
export function cubeletPluginConfiguration(base) {
  const marker = `    [[plugins."io.cubelet.internal.v1.storage".volume_plugins]]
      name        = "cos"
      type        = "binary"
      binary_path = "/usr/local/services/cubetoolbox/Cubelet/plugin/cube-volume-cos"`;
  if (!base.includes(marker)) throw new Error("Pinned Cubelet storage configuration changed");
  const configured = base.includes(`name        = "${plugin}"`)
    ? base
    : base.replace(
        marker,
        `${marker}

    [[plugins."io.cubelet.internal.v1.storage".volume_plugins]]
      name        = "${plugin}"
      type        = "binary"
      binary_path = "/usr/local/services/cubetoolbox/Cubelet/plugin/cube-volume-picloud-posix"`,
      );
  return withCubeExecutionCompletion(configured);
}

/** Pure manifest transformation. No cluster read or mutation happens here. */
export function renderCubeRelease(yaml, input) {
  if (
    input.version !== 1 ||
    !input.sharedRoot?.startsWith("/") ||
    !input.sharedRootIdentity ||
    !input.pluginSource ||
    !input.cubeletConfig ||
    !input.completionFiles
  )
    throw new Error("Invalid Cube render inputs");
  const resources = parseAllDocuments(yaml, { version: "1.1" })
    .map((document) => {
      if (document.errors.length) throw new Error("Invalid Cube manifest YAML");
      return document.toJS();
    })
    .filter(Boolean);
  const required = (kind, name) => {
    const found = resources.filter((r) => r.kind === kind && r.metadata?.name === name);
    if (found.length !== 1) throw new Error(`Pinned Cube chart must contain one ${kind}/${name}`);
    return found[0];
  };
  const node = required("DaemonSet", "cube-node"),
    master = required("Deployment", "cube-master");
  const sharedSecret = required("Secret", "cube-secret");
  const redisPassword =
    sharedSecret.stringData?.["redis-password"] ??
    (sharedSecret.data?.["redis-password"]
      ? Buffer.from(sharedSecret.data["redis-password"], "base64").toString()
      : undefined);
  if (!redisPassword) throw new Error("Pinned Cube Redis credential is missing");
  for (const resource of resources)
    if (
      ["StatefulSet", "Deployment"].includes(resource.kind) &&
      ["cube-redis", "cube-master", "cube-proxy", "cube-lifecycle-manager"].includes(
        resource.metadata?.name,
      )
    )
      annotate(resource, { "pi-cloud.io/redis-credential-revision": hash(redisPassword) });
  const masterSecret = required("Secret", "cube-master-config");
  const conf =
    masterSecret.stringData?.["conf.yaml"] ??
    (masterSecret.data?.["conf.yaml"]
      ? Buffer.from(masterSecret.data["conf.yaml"], "base64").toString()
      : undefined);
  if (!conf) throw new Error("Pinned Cube Master configuration is missing");
  const masterConfig = parse(conf, { version: "1.1" });
  if (!Array.isArray(masterConfig.volume_plugins))
    throw new Error("Pinned Cube Master plugin configuration changed");
  upsert(masterConfig.volume_plugins, {
    name: plugin,
    type: "binary",
    binary_path: "/usr/local/services/cubetoolbox/CubeMaster/plugin/cube-volume-picloud-posix",
  });
  masterSecret.stringData = {
    ...masterSecret.stringData,
    "conf.yaml": stringify(masterConfig, { version: "1.1", directives: false }),
  };
  if (masterSecret.data) delete masterSecret.data["conf.yaml"];
  const config = cubeletPluginConfiguration(input.cubeletConfig);
  const fingerprint = {
    "pi-cloud.io/posix-shared-root-identity": input.sharedRootIdentity,
    "pi-cloud.io/posix-volume-plugin-sha256": hash(input.pluginSource),
  };
  annotate(master, {
    ...fingerprint,
    "pi-cloud.io/master-configuration": hash(masterSecret.stringData["conf.yaml"]),
  });
  annotate(node, { ...fingerprint, "pi-cloud.io/cubelet-configuration": hash(config) });
  const masterPod = master.spec.template.spec,
    nodePod = node.spec.template.spec;
  const pluginVolume = {
    name: "picloud-posix-volume-plugin",
    configMap: { name: CUBE_PLUGIN_CONFIG, defaultMode: 365 },
  };
  upsert((masterPod.volumes ??= []), pluginVolume);
  upsert(masterPod.volumes, {
    name: "picloud-posix-shared",
    hostPath: { path: input.sharedRoot, type: "Directory" },
  });
  mount(masterPod, "cube-master", {
    name: pluginVolume.name,
    mountPath: "/usr/local/services/cubetoolbox/CubeMaster/plugin/cube-volume-picloud-posix",
    subPath: "cube-volume-picloud-posix",
    readOnly: true,
  });
  mount(masterPod, "cube-master", { name: "picloud-posix-shared", mountPath: "/data/cube-shared" });
  upsert((nodePod.volumes ??= []), pluginVolume);
  upsert(nodePod.volumes, {
    name: "data-cube-shared",
    hostPath: { path: input.sharedRoot, type: "Directory" },
  });
  for (const name of ["cubelet", "network-agent"])
    mount(nodePod, name, { name: "data-cube-shared", mountPath: "/data/cube-shared" });
  mount(nodePod, "cubelet", {
    name: pluginVolume.name,
    mountPath: "/opt/cube-image/Cubelet/plugin/cube-volume-picloud-posix",
    subPath: "cube-volume-picloud-posix",
    readOnly: true,
  });
  mount(nodePod, "cubelet", {
    name: pluginVolume.name,
    mountPath: "/opt/cube-image/Cubelet/config/config.toml",
    subPath: "cubelet-config.toml",
    readOnly: true,
  });
  const completion = cubeCompletionPatch({
    kafkaBrokers: ["kafka-1:9092", "kafka-2:9092", "kafka-3:9092"],
    controlPlaneUrl: "http://control-plane:3000",
    imageEndpoint: "http://session-images:8333",
    secretDigest: hash(JSON.stringify(input.completionFiles)),
  }).spec.template;
  annotate(node, completion.metadata.annotations);
  const cubelet = container(nodePod, "cubelet"),
    additions = completion.spec.containers[0];
  for (const entry of additions.env) upsert((cubelet.env ??= []), entry);
  for (const entry of additions.volumeMounts) upsert(cubelet.volumeMounts, entry);
  for (const entry of completion.spec.volumes) upsert(nodePod.volumes, entry);
  const owned = [
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: CUBE_PLUGIN_CONFIG, namespace: "cube-system" },
      data: { "cubelet-config.toml": config, "cube-volume-picloud-posix": input.pluginSource },
    },
    cubeCompletionSecret(
      Object.fromEntries(
        Object.entries(input.completionFiles).map(([name, bytes]) => [
          name,
          Buffer.from(bytes, "base64"),
        ]),
      ),
    ),
  ];
  for (const resource of owned) {
    const prior = resources.findIndex(
      (r) => r.kind === resource.kind && r.metadata?.name === resource.metadata.name,
    );
    if (prior < 0) resources.push(resource);
    else resources[prior] = resource;
  }
  // Kubernetes' YAML decoder uses YAML 1.1 (off/on and octal literals). JSON
  // documents retain exact scalar types across Helm and that decoder.
  return resources.map((resource) => JSON.stringify(resource, null, 2) + "\n").join("---\n");
}
