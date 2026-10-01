import { expect, it } from "vitest";
import {
  withCubeExecutionCompletion,
  cubeCompletionBridge,
  cubeCompletionPatch,
  cubeCompletionSecret,
  readyCubeletPod,
} from "./cube-execution-deployment.mjs";

it("selects a live Cubelet container during a DaemonSet replacement", () => {
  const pod = (name, deletionTimestamp, ready, state, container = "cubelet") => ({
    metadata: { name, deletionTimestamp },
    status: { phase: "Running", containerStatuses: [{ name: container, ready, state }] },
  });
  const stale = pod("old", "2026-10-01T00:00:00Z", true, { running: {} });
  const restarting = pod("new", undefined, false, { waiting: {} });
  const sidecar = pod("sidecar-only", undefined, true, { running: {} }, "network-agent");
  expect(readyCubeletPod([stale, restarting, sidecar])).toBeUndefined();
  expect(readyCubeletPod([stale, pod("ready", undefined, true, { running: {} })])).toBe("ready");
});

it("installs one fixed completion command in the Cubelet service section", () => {
  const text =
    '[plugins."io.cubelet.cubebox-service.v1.cubebox-service"]\n  create_deadline="1m"\n[plugins.other]\n';
  const updated = withCubeExecutionCompletion(text);
  expect(updated.match(/execution_completion_command/g)).toHaveLength(1);
  expect(withCubeExecutionCompletion(updated)).toBe(updated);
  expect(updated).toContain("/opt/pi-cloud/packages/cube-completion/src/main.ts");
  expect(() => withCubeExecutionCompletion("[plugins.other]")).toThrow("section");
});
it("keeps completion credentials on the trusted Cubelet container", () => {
  const patch = cubeCompletionPatch({
    kafkaBrokers: ["kafka-1:9092"],
    controlPlaneUrl: "http://control-plane:3000",
    imageEndpoint: "http://session-images:8333",
  });
  expect(patch.spec.template.spec.containers.map((c) => c.name)).toEqual(["cubelet"]);
  expect(patch.spec.template.spec.volumes[0].secret.defaultMode).toBe(256);
  expect(JSON.stringify(patch)).not.toContain("api-key");
  const secret = cubeCompletionSecret({ "database-url": Buffer.from("fixture") });
  expect(Buffer.from(secret.data["database-url"], "base64").toString()).toBe("fixture");
});
it("bridges advertised Kafka names to explicit reachable addresses", () => {
  const objects = cubeCompletionBridge([{ name: "kafka-1", address: "172.20.0.3", port: 9092 }]);
  expect(objects[0].metadata.name).toBe("kafka-1");
  expect(objects[1].endpoints[0].addresses).toEqual(["172.20.0.3"]);
  expect(() =>
    cubeCompletionBridge([{ name: "../wrong", address: "172.20.0.3", port: 9092 }]),
  ).toThrow();
});
