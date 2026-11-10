import { expect, it, vi } from "vitest";
import { reconcileCubeEgressGateway } from "./cube-egress-release.mjs";
function fixture(stuck = false) {
  const state = {
    metadata: { generation: 1 },
    spec: { replicas: 0, template: { spec: { containers: [{ name: "gateway", image: "old" }] } } },
    status: { observedGeneration: 1, updatedReplicas: 0, availableReplicas: 0 },
  };
  const kubectl = vi.fn((args) => {
    if (args[0] === "set")
      state.spec.template.spec.containers[0].image = args[3].slice("gateway=".length);
    if (args[0] === "scale" && !stuck) {
      state.spec.replicas = 1;
      state.status.updatedReplicas = 1;
      state.status.availableReplicas = 1;
    }
    return args[0] === "get" ? JSON.stringify(state) : "rollout successful";
  });
  return { state, kubectl };
}
it("restores the declared gateway after zero-replica maintenance", () => {
  const f = fixture();
  reconcileCubeEgressGateway(f.kubectl, "image:new");
  expect(f.state.spec.replicas).toBe(1);
  expect(f.state.spec.template.spec.containers[0].image).toBe("image:new");
});
it("does not accept a successful rollout string without a serving gateway", () => {
  const f = fixture(true);
  expect(() => reconcileCubeEgressGateway(f.kubectl, "image:new")).toThrow("serving replica");
});
