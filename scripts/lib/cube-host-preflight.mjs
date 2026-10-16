import assert from "node:assert/strict";

// Pod readiness alone does not prove that a rebooted host still exposes KVM.
// This read-only check runs before draining applications. It is not a VM-start
// guarantee; template creation and live acceptance still verify the full path.
export function assertCubeKvmAvailable({ kubectl }) {
  const selector = "app.kubernetes.io/instance=cube,app.kubernetes.io/component=cube-node";
  const daemonset = JSON.parse(kubectl(["get", "daemonset/cube-node", "-o", "json"]));
  const expected = daemonset.status?.desiredNumberScheduled;
  assert(Number.isInteger(expected) && expected > 0, "No scheduled Cube compute node");
  const pods = JSON.parse(kubectl(["get", "pods", "-l", selector, "-o", "json"])).items;
  assert(
    pods.length === expected &&
      pods.every(
        (pod) =>
          !pod.metadata.deletionTimestamp &&
          pod.status.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
      ),
    "Every Cube compute node must be Ready before matched replacement",
  );
  for (const pod of pods) {
    try {
      kubectl(
        [
          "exec",
          pod.metadata.name,
          "-c",
          "cubelet",
          "--",
          "sh",
          "-c",
          "test -c /dev/kvm && test -r /dev/kvm && test -w /dev/kvm",
        ],
        { timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] },
      );
    } catch (cause) {
      throw new Error(
        `KVM unavailable on Cube node ${pod.spec.nodeName}; repair host virtualization before draining applications`,
        { cause },
      );
    }
  }
}
