import { expect, it } from "vitest";
import { parse, parseAllDocuments, stringify } from "yaml";
import { renderCubeRelease } from "./cube-release-render.mjs";
import { cubeAdoptionFlags } from "./cube-release-inputs.mjs";
import { assertCubeWorkspaceContract } from "./cube-workspace-contract.mjs";

const input = {
  version: 1,
  sharedRoot: "/private/pi-cloud/state/cube-shared",
  sharedRootIdentity: "1-2",
  pluginSource: "#!/bin/sh\nexit 0\n",
  cubeletConfig: `[plugins."io.cubelet.internal.v1.storage"]
    [[plugins."io.cubelet.internal.v1.storage".volume_plugins]]
      name        = "cos"
      type        = "binary"
      binary_path = "/usr/local/services/cubetoolbox/Cubelet/plugin/cube-volume-cos"
[plugins."io.cubelet.cubebox-service.v1.cubebox-service"]
    create_deadline = "1m"
`,
  completionFiles: Object.fromEntries(
    ["database-url", "supervisor-management-token", "session-image-s3-credentials.json"].map(
      (name) => [name, Buffer.from("fixture").toString("base64")],
    ),
  ),
};
function workload(kind, name, containers) {
  return {
    apiVersion: "apps/v1",
    kind,
    metadata: { name },
    spec: { template: { metadata: { labels: { app: name } }, spec: { containers, volumes: [] } } },
  };
}
function fixture() {
  return [
    workload("DaemonSet", "cube-node", [
      {
        name: "cubelet",
        image: "pi-cloud/cubelet:pinned",
        env: [{ name: "CUBE_NODE_IP", valueFrom: { fieldRef: { fieldPath: "status.hostIP" } } }],
      },
      { name: "network-agent", image: "upstream:fixed" },
    ]),
    workload("Deployment", "cube-master", [
      { name: "cube-master", image: "pi-cloud/cube-master:pinned" },
    ]),
    workload("StatefulSet", "cube-redis", [{ name: "redis", image: "redis:fixed" }]),
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "cube-master-config" },
      stringData: {
        "conf.yaml": "volume_plugins:\n  - name: cos\n    type: binary\n    binary_path: /cos\n",
      },
    },
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: { name: "cube-secret" },
      data: { "redis-password": Buffer.from("redis-fixture").toString("base64") },
    },
  ]
    .map((r) => stringify(r))
    .join("---\n");
}
const objects = (value) => parseAllDocuments(value).map((document) => document.toJS());
const find = (resources, kind, name) =>
  resources.find((r) => r.kind === kind && r.metadata.name === name);

it("renders a complete, idempotent Cube release before deployment while retaining image versions", () => {
  const rendered = renderCubeRelease(fixture(), input),
    resources = objects(rendered);
  expect(renderCubeRelease(rendered, input)).toBe(rendered);
  const node = find(resources, "DaemonSet", "cube-node"),
    master = find(resources, "Deployment", "cube-master");
  assertCubeWorkspaceContract(master, node, input.sharedRoot);
  const cubelet = node.spec.template.spec.containers[0],
    network = node.spec.template.spec.containers[1];
  expect(cubelet.image).toBe("pi-cloud/cubelet:pinned");
  expect(master.spec.template.spec.containers[0].image).toBe("pi-cloud/cube-master:pinned");
  expect(cubelet.env.find((e) => e.name === "CUBE_NODE_IP").valueFrom.fieldRef.fieldPath).toBe(
    "status.hostIP",
  );
  expect(cubelet.env.find((e) => e.name === "PI_CLOUD_KAFKA_BROKERS").value).toBe(
    "kafka-1:9092,kafka-2:9092,kafka-3:9092",
  );
  expect(network.volumeMounts.some((v) => v.name === "pi-cloud-completion")).toBe(false);
  const config = find(resources, "ConfigMap", "pi-cloud-posix-volume-plugin").data;
  expect(config["cubelet-config.toml"]).toContain("execution_completion_command");
  expect(config["cubelet-config.toml"]).toContain("cube-volume-picloud-posix");
  const masterConfig = parse(
    find(resources, "Secret", "cube-master-config").stringData["conf.yaml"],
  );
  expect(masterConfig.volume_plugins.map((p) => p.name)).toEqual(["cos", "picloud-posix"]);
  expect(find(resources, "Secret", "pi-cloud-cube-completion").data).toEqual(input.completionFiles);
});

it("rolls the exact configuration consumers when plugins, credentials or shared-root identity change", () => {
  const baseline = objects(renderCubeRelease(fixture(), input));
  const changes = [
    { ...input, sharedRootIdentity: "1-3" },
    { ...input, pluginSource: "#!/bin/sh\nexit 1\n" },
    {
      ...input,
      completionFiles: {
        ...input.completionFiles,
        "database-url": Buffer.from("rotated").toString("base64"),
      },
    },
  ];
  for (const change of changes) {
    const next = objects(renderCubeRelease(fixture(), change));
    expect(find(next, "DaemonSet", "cube-node").spec.template.metadata.annotations).not.toEqual(
      find(baseline, "DaemonSet", "cube-node").spec.template.metadata.annotations,
    );
  }
  const changedRedis = fixture().replace(
    Buffer.from("redis-fixture").toString("base64"),
    Buffer.from("new-redis").toString("base64"),
  );
  const next = objects(renderCubeRelease(changedRedis, input));
  for (const [kind, name] of [
    ["StatefulSet", "cube-redis"],
    ["Deployment", "cube-master"],
  ])
    expect(
      find(next, kind, name).spec.template.metadata.annotations[
        "pi-cloud.io/redis-credential-revision"
      ],
    ).not.toBe(
      find(baseline, kind, name).spec.template.metadata.annotations[
        "pi-cloud.io/redis-credential-revision"
      ],
    );
});

it("rejects unexpected chart shapes and foreign resource ownership", () => {
  expect(() =>
    renderCubeRelease(fixture().replace("name: cubelet", "name: changed"), input),
  ).toThrow("cubelet");
  expect(() => renderCubeRelease(fixture(), { ...input, cubeletConfig: "[changed]" })).toThrow(
    "configuration",
  );
  const resource = { kind: "ConfigMap", metadata: { name: "pi-cloud-posix-volume-plugin" } };
  expect(cubeAdoptionFlags([resource])).toEqual(["--take-ownership"]);
  resource.metadata.annotations = {
    "meta.helm.sh/release-name": "cube",
    "meta.helm.sh/release-namespace": "cube-system",
  };
  expect(cubeAdoptionFlags([resource])).toEqual([]);
  resource.metadata.annotations["meta.helm.sh/release-name"] = "someone-else";
  expect(() => cubeAdoptionFlags([resource])).toThrow("different");
  expect(() => cubeAdoptionFlags([{ kind: "Secret", metadata: { name: "unrelated" } }])).toThrow(
    "Unexpected",
  );
});
