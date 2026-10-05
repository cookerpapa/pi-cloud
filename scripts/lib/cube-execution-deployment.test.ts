import { expect, it } from "vitest";
import {
  withCubeExecutionCompletion,
  cubeCompletionPatch,
  cubeCompletionSecret,
  readyCubeletPod,
  waitForReadyCubelet,
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

it("waits past an old ready Pod and a not-yet-ready replacement", async () => {
  const pod = (name, image, ready) => ({
    metadata: { name },
    spec: { containers: [{ name: "cubelet", image }] },
    status: { containerStatuses: [{ name: "cubelet", image, ready, state: { running: {} } }] },
  });
  const old = pod("old", "cube:v1", true),
    next = pod("next", "cube:v2", false);
  let attempt = 0,
    now = 0;
  expect(
    await waitForReadyCubelet({
      expectedImage: "cube:v2",
      timeoutMs: 5000,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      readPods: async () => (++attempt < 3 ? [old, next] : [old, pod("next", "cube:v2", true)]),
    }),
  ).toBe("next");
  expect(attempt).toBe(3);
  now = 0;
  await expect(
    waitForReadyCubelet({
      expectedImage: "cube:v2",
      timeoutMs: 2000,
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
      readPods: async () => [old, next],
    }),
  ).rejects.toThrow("cube:v2");
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
