import assert from "node:assert/strict";

/** The declared host-network gateway is a singleton, including after a stopped
 * installation. rollout status alone also succeeds for zero replicas. */
export function reconcileCubeEgressGateway(kubectl, image) {
  const target = "deployment/pi-cloud-cube-egress-gateway";
  kubectl(["set", "image", target, `gateway=${image}`]);
  kubectl(["scale", target, "--replicas=1"]);
  kubectl(["rollout", "status", target, "--timeout=120s"], { timeout: 125000 });
  const value = JSON.parse(kubectl(["get", target, "-o", "json"]));
  assert.equal(value.spec.replicas, 1, "Egress gateway has no serving replica");
  assert.equal(value.status.updatedReplicas, 1, "Egress gateway update is not serving");
  assert.equal(value.status.availableReplicas, 1, "Egress gateway is unavailable");
  assert(
    value.status.observedGeneration >= value.metadata.generation,
    "Egress gateway generation is not observed",
  );
  assert.equal(
    value.spec.template.spec.containers.find((c) => c.name === "gateway")?.image,
    image,
    "Egress gateway image changed",
  );
}
