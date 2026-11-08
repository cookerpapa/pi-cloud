import { expect, it, vi } from "vitest";
import { waitForCubeNodeReadiness } from "./cube-node-readiness.mjs";

function fixture() {
  let time = 0;
  const pod = {
    metadata: { uid: "new-pod" },
    spec: { containers: [{ name: "cubelet" }] },
    status: {
      podIP: "10.0.0.2",
      startTime: "2026-11-08T00:00:10Z",
      conditions: [{ type: "Ready", status: "True" }],
    },
  };
  const node = {
    IP: "10.0.0.2",
    Healthy: true,
    ReportedReady: true,
    MetricUpdateAt: "2026-11-08T00:00:11Z",
  };
  const kubectl = vi.fn(async (args) =>
    JSON.stringify(
      args[1] === "pods"
        ? { items: [pod] }
        : { spec: { clusterIP: "10.0.0.3", ports: [{ port: 3010 }] } },
    ),
  );
  const request = vi.fn(async () => ({ ok: true, json: async () => [node] }));
  return {
    pod,
    node,
    kubectl,
    request,
    now: () => time,
    pause: async (ms) => {
      time += ms;
    },
  };
}
it("waits for native readiness after Pod readiness without issuing a create", async () => {
  const f = fixture();
  f.request.mockResolvedValueOnce({ ok: true, json: async () => [{ ...f.node, Healthy: false }] });
  expect(await waitForCubeNodeReadiness(f)).toEqual({ nodes: 1 });
  expect(f.request).toHaveBeenCalledTimes(3);
  expect(f.kubectl.mock.calls.every(([args]) => args[0] === "get")).toBe(true);
});
it("rejects stale old-Pod heartbeats and bounds an unavailable native node view", async () => {
  const f = fixture();
  f.node.MetricUpdateAt = "2026-11-08T00:00:09Z";
  await expect(waitForCubeNodeReadiness({ ...f, timeoutMs: 2000 })).rejects.toThrow(
    "did not become ready",
  );
});
it("does not accept a healthy report for a replaced node address", async () => {
  const f = fixture();
  f.node.IP = "10.0.0.1";
  await expect(waitForCubeNodeReadiness({ ...f, timeoutMs: 2000 })).rejects.toThrow(
    "did not become ready",
  );
});
