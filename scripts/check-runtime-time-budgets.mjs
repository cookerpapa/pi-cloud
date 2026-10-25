import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseDocument } from "yaml";

const MAX_TOOL_EXECUTION_MS = 5 * 60_000;
const TOOL_TRANSPORT_MARGIN_MS = 60_000;
const WORKER_SETTLEMENT_GRACE_MS = 5 * 60_000;
const PROCESS_SHUTDOWN_MARGIN_MS = 60_000;
const WORKSPACE_VOLUME_GATEWAY_HTTP_MS = 11 * 60_000;
const CUBE_LIFECYCLE_REQUEST_MS = 2 * 60_000;

function integer(value, description) {
  const parsed = Number(value);
  assert.ok(
    Number.isSafeInteger(parsed) && parsed > 0,
    `${description} must be a positive integer`,
  );
  return parsed;
}

function durationMs(value, description) {
  const match = /^(\d+)(ms|s|m|h)$/.exec(String(value));
  assert.ok(match, `${description} must use one bounded duration unit`);
  const factors = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 };
  return integer(match[1], description) * factors[match[2]];
}

function validateWorkerPolicy(policy, description) {
  const manager = integer(policy.sandboxControlRequestMs, `${description} Sandbox control timeout`);
  const drain = integer(policy.workerDrainMs, `${description} Worker drain`);
  const retirement = integer(policy.workerRetirementMs, `${description} Worker retirement`);
  const upstreamConnect = integer(policy.modelConnectMs, `${description} upstream connect timeout`);
  const model = integer(policy.modelEventIdleMs, `${description} model event idle timeout`);
  const termination = integer(policy.terminationGraceMs, `${description} termination grace`);

  assert.ok(
    manager >= MAX_TOOL_EXECUTION_MS + TOOL_TRANSPORT_MARGIN_MS,
    `${description} can time out before a maximum Tool result is returned`,
  );
  assert.ok(
    upstreamConnect < model,
    `${description} model event timeout must outlive connection establishment`,
  );
  assert.ok(
    retirement >= manager + WORKER_SETTLEMENT_GRACE_MS,
    `${description} retirement can outlive cleanup`,
  );
  assert.ok(
    termination >= drain + retirement + PROCESS_SHUTDOWN_MARGIN_MS,
    `${description} process can be killed before its fenced retirement completes`,
  );
}

function validateWorkspaceVolumeGatewayPolicy(policy, description) {
  const queueWait = integer(policy.queueWaitMs, `${description} queue wait`);
  const request = integer(policy.requestMs, `${description} request timeout`);
  const termination = integer(policy.terminationGraceMs, `${description} termination grace`);
  assert.ok(
    queueWait < request,
    `${description} queue can consume its complete HTTP request budget`,
  );
  assert.ok(
    termination >= request + PROCESS_SHUTDOWN_MARGIN_MS,
    `${description} process can be killed before an admitted operation drains`,
  );
}

function yaml(path) {
  const document = parseDocument(readFileSync(path, "utf8"));
  assert.equal(document.errors.length, 0, `${path} is invalid YAML`);
  return document.toJSON();
}

const workerValues = yaml("deploy/helm/pi-cloud-pi-worker-pool/values.yaml");
validateWorkerPolicy(
  {
    ...workerValues.runtime.timeouts,
    terminationGraceMs: workerValues.lifecycle.terminationGracePeriodSeconds * 1_000,
  },
  "Pi Worker Helm chart",
);
const platformValues = yaml("deploy/helm/pi-cloud-platform/values.yaml");
validateWorkerPolicy(
  {
    ...platformValues["pi-workers"].runtime.timeouts,
    terminationGraceMs:
      platformValues["pi-workers"].lifecycle.terminationGracePeriodSeconds * 1_000,
  },
  "Platform Helm chart",
);
validateWorkspaceVolumeGatewayPolicy(
  {
    queueWaitMs: platformValues.sandboxPlane.volumeGatewayQueueWaitTimeoutMs,
    requestMs: platformValues.sandboxPlane.volumeGatewayRequestTimeoutMs,
    terminationGraceMs: 720_000,
  },
  "Platform Helm Workspace Volume Gateway",
);
assert.ok(
  platformValues.sandboxPlane.cube.requestTimeoutMs >= CUBE_LIFECYCLE_REQUEST_MS,
  "Platform Helm Cube lifecycle timeout is too short for a full-VM pause",
);
assert.ok(
  platformValues.global.kafka.acceptedFactRetentionMs > 0,
  "Platform Kafka retention grace must be positive; safe projection progress controls reclamation",
);

process.stdout.write("runtime_time_budget_check_passed\n");
