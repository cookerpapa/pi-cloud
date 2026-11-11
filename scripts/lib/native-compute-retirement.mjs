import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { BoxLiteRuntimeClient } from "../../packages/sandbox-control/src/boxlite-runtime-client.ts";

/** Retire the capsule's recorded provider, not the provider selected for the
 * next release. This port cannot create compute or delete Workspace bytes. */
export function nativeComputeRetirement({ cube, runtimeDirectory, kubectl }) {
  const boxes = new Map();
  return {
    async destroy(target) {
      if (target.providerId === "cubesandbox") return cube.destroy(target.runtimeName);
      assert.equal(target.providerId, "boxlite");
      const key = target.endpoint + "|" + target.nodeId;
      let client = boxes.get(key);
      if (!client) {
        const url = new URL(target.endpoint);
        assert(
          !url.username && !url.password && !url.search && !url.hash,
          "Unexpected recorded provider endpoint",
        );
        if (
          url.hostname === "pi-cloud-boxlite" ||
          url.hostname === "pi-cloud-boxlite.cube-system.svc.cluster.local"
        )
          url.hostname = JSON.parse(
            kubectl(["get", "service", "pi-cloud-boxlite", "-o", "json"]),
          ).spec.clusterIP;
        client = new BoxLiteRuntimeClient({
          url: url.toString(),
          nodeId: target.nodeId,
          token: (
            await readFile(resolve(runtimeDirectory, "secrets/sandbox-control-token"), "utf8")
          ).trim(),
          volumes: {
            ensureVolume() {
              throw new Error("Compute maintenance cannot create storage");
            },
            deleteVolume() {
              throw new Error("Compute maintenance cannot delete storage");
            },
            async close() {},
          },
        });
        boxes.set(key, client);
      }
      await client.destroy(target.runtimeName, target.instance);
    },
    async close() {
      await Promise.all([...boxes.values()].map((client) => client.close()));
    },
  };
}
