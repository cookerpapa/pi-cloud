import assert from "node:assert/strict";
import { test } from "vitest";
import {
  assertCubeWorkspaceContract,
  assertCubeNativeVersion,
} from "./cube-workspace-contract.mjs";
const root = "/operator/runtime/state/cube-shared";
function fixture(names) {
  return {
    spec: {
      template: {
        spec: {
          containers: names.map((name) => ({
            name,
            volumeMounts: [
              { name: "shared", mountPath: "/data/cube-shared" },
              ...(["cubelet", "cube-master"].includes(name)
                ? [
                    {
                      name: "plugin",
                      mountPath:
                        name === "cubelet"
                          ? "/opt/cube-image/Cubelet/plugin/cube-volume-picloud-posix"
                          : "/usr/local/services/cubetoolbox/CubeMaster/plugin/cube-volume-picloud-posix",
                      subPath: "cube-volume-picloud-posix",
                      readOnly: true,
                    },
                  ]
                : []),
              ...(name === "cubelet"
                ? [
                    {
                      name: "plugin",
                      mountPath: "/opt/cube-image/Cubelet/config/config.toml",
                      subPath: "cubelet-config.toml",
                      readOnly: true,
                    },
                  ]
                : []),
            ],
          })),
          volumes: [
            { name: "shared", hostPath: { path: root } },
            { name: "plugin", configMap: { name: "pi-cloud-posix-volume-plugin" } },
          ],
        },
      },
    },
  };
}
test("accepts a single Workspace byte authority and detects chart-restored default mounts", () => {
  const master = fixture(["cube-master"]),
    node = fixture(["cubelet"]);
  assert.doesNotThrow(() => assertCubeWorkspaceContract(master, node, root));
  node.spec.template.spec.volumes[0].hostPath.path = "/data/cube-shared";
  assert.throws(() => assertCubeWorkspaceContract(master, node, root), /Workspace mount drifted/);
});
test("detects a removed Cubelet config mount even when the Workspace host path is intact", () => {
  const master = fixture(["cube-master"]),
    node = fixture(["cubelet"]);
  node.spec.template.spec.containers[0].volumeMounts.pop();
  assert.throws(
    () => assertCubeWorkspaceContract(master, node, root),
    /plugin configuration drifted/,
  );
});

test("requires the pinned native Cube release independently of the completion application", () => {
  assert.doesNotThrow(() =>
    assertCubeNativeVersion(
      { schema_version: 1, components: { cubelet: { version: "v0.7.3" } } },
      "v0.7.3",
    ),
  );
  for (const probe of [
    { schema_version: 1, components: { cubelet: { version: "old" } } },
    { schema_version: 1, components: { cubelet: { version: "0.7.3-picloud-old" } } },
    { schema_version: 2, components: { cubelet: { version: "v0.7.3" } } },
    { components: { cubelet: { version: "v0.7.3" } } },
  ])
    assert.throws(() => assertCubeNativeVersion(probe, "v0.7.3"), /Update Cube/);
});

test("refuses a missing executable even when the same ConfigMap still provides the config", () => {
  const master = fixture(["cube-master"]),
    node = fixture(["cubelet"]);
  const container = node.spec.template.spec.containers[0];
  container.volumeMounts = container.volumeMounts.filter(
    (m) => m.subPath !== "cube-volume-picloud-posix",
  );
  assert.throws(() => assertCubeWorkspaceContract(master, node, root), /executable mount drifted/);
});
