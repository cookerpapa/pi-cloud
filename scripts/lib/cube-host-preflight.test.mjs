import { expect, it } from "vitest";
import { assertCubeKvmAvailable } from "./cube-host-preflight.mjs";

function fixture({ missingKvm = false, ready = true, count = 2, expected = 2 } = {}) {
  const checked = [];
  const kubectl = (args) => {
    if (args[0] === "get" && args[1] === "daemonset/cube-node")
      return JSON.stringify({ status: { desiredNumberScheduled: expected } });
    if (args[0] === "get" && args[1] === "pods")
      return JSON.stringify({
        items: Array.from({ length: count }, (_, i) => ({
          metadata: { name: `cube-${i}` },
          spec: { nodeName: `node-${i}` },
          status: { conditions: [{ type: "Ready", status: ready ? "True" : "False" }] },
        })),
      });
    if (args[0] === "exec") {
      expect(args.slice(2)).toEqual([
        "-c",
        "cubelet",
        "--",
        "sh",
        "-c",
        "test -c /dev/kvm && test -r /dev/kvm && test -w /dev/kvm",
      ]);
      checked.push(args[1]);
      if (missingKvm && args[1] === "cube-1") throw new Error("device absent");
      return "";
    }
    throw new Error("Unexpected cluster mutation");
  };
  return { kubectl, checked };
}

it("checks the KVM device on every Ready compute node without mutations", () => {
  const f = fixture();
  assertCubeKvmAvailable(f);
  expect(f.checked).toEqual(["cube-0", "cube-1"]);
});

it("rejects a Ready Cubelet whose host has lost KVM", () => {
  expect(() => assertCubeKvmAvailable(fixture({ missingKvm: true }))).toThrow(
    "KVM unavailable on Cube node node-1",
  );
});

it.each([{ ready: false }, { count: 1 }, { count: 0, expected: 0 }])(
  "rejects incomplete compute-node coverage %j",
  (options) => {
    const f = fixture(options);
    expect(() => assertCubeKvmAvailable(f)).toThrow();
    expect(f.checked).toEqual([]);
  },
);
