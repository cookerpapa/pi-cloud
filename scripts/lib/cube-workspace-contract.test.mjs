import assert from "node:assert/strict";
import { test } from "vitest";
import {
  assertCubeWorkspaceContract,
  assertCubeCompletionVersion,
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
    node = fixture(["cubelet", "network-agent"]);
  assert.doesNotThrow(() => assertCubeWorkspaceContract(master, node, root));
  node.spec.template.spec.volumes[0].hostPath.path = "/data/cube-shared";
  assert.throws(() => assertCubeWorkspaceContract(master, node, root), /Workspace mount drifted/);
});
test("detects a removed Cubelet config mount even when the Workspace host path is intact", () => {
  const master = fixture(["cube-master"]),
    node = fixture(["cubelet", "network-agent"]);
  node.spec.template.spec.containers[0].volumeMounts.pop();
  assert.throws(
    () => assertCubeWorkspaceContract(master, node, root),
    /plugin configuration drifted/,
  );
});

test("requires matching native Cubelet patches and completion protocol sources", () => {
  assert.doesNotThrow(() =>
    assertCubeCompletionVersion(
      { source: "current", version: "0.6.0-picloud-expected" },
      "current",
      "expected",
    ),
  );
  assert.throws(
    () =>
      assertCubeCompletionVersion(
        { source: "current", version: "0.6.0-picloud-old" },
        "current",
        "expected",
      ),
    /Update Cubelet/,
  );
  assert.throws(
    () =>
      assertCubeCompletionVersion(
        { source: "old", version: "0.6.0-picloud-expected" },
        "current",
        "expected",
      ),
    /Update Cubelet/,
  );
});
