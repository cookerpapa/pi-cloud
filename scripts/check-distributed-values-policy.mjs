import assert from "node:assert/strict";
import { validateDistributedDeploymentValues } from "./distributed-values-policy.mjs";

const valid = {
  global: { imageRevision: "a".repeat(40) },
  images: Object.fromEntries(
    ["controlPlane", "web", "toolBroker", "sshGateway"].map((name) => [
      name,
      { repository: `registry.internal/pi-cloud/${name}`, tag: "release-1" },
    ]),
  ),
  external: {
    providerProxyUrl: "https://provider.internal:3129",
    kafka: { brokers: ["kafka.internal:9092"], acceptedFactRetentionMs: 7_200_000 },
  },
  sandboxPlane: {
    cube: { apiUrl: "https://cube.internal", templateId: `tpl-${"a".repeat(24)}` },
    volumeGatewayQueueWaitTimeoutMs: 30_000,
    volumeGatewayRequestTimeoutMs: 660_000,
  },
  "pi-workers": {
    image: { repository: "registry.internal/pi-cloud/worker", tag: "release-1" },
    lifecycle: { terminationGracePeriodSeconds: 1_320 },
    runtime: {
      subagents: { maximumConcurrent: 3 },
      timeouts: {
        toolBrokerRequestMs: 360_000,
        modelCapabilityTtlMs: 900_000,
        modelUpstreamRequestMs: 120_000,
        modelRequestMs: 150_000,
        turnMs: 600_000,
      },
    },
  },
};

validateDistributedDeploymentValues(valid);
assert.throws(
  () =>
    validateDistributedDeploymentValues({
      ...valid,
      global: { imageRevision: "git-sha-0123456789abcdef" },
    }),
  /example placeholder|full lowercase Git revision/u,
);
process.stdout.write("distributed_values_policy_check_passed\n");
