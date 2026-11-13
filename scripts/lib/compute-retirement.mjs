import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const stoppedComponents = new Set([
  "control-plane",
  "session-runtime",
  "trusted-pi-worker",
  "web",
  "ssh-gateway",
  "workspace-volume-gateway",
]);
const component = (object) => object.metadata?.labels?.["app.kubernetes.io/component"];

/** Inventory installed roles. This does not alias the old combined process to
 * the new Session Runtime or assume that an uninstalled workload is stopped. */
export function assertRetirementProcessesStopped({ workloads, pods }) {
  assert(Array.isArray(workloads) && Array.isArray(pods), "Missing process inventory");
  const installed = workloads.filter((item) => stoppedComponents.has(component(item)));
  assert(
    installed.some((item) => component(item) === "control-plane"),
    "Control Plane inventory is missing",
  );
  for (const workload of installed)
    assert.equal(
      workload.spec?.replicas ?? 1,
      0,
      "An installed admission/runtime workload is not stopped",
    );
  assert(
    !pods.some((pod) => stoppedComponents.has(component(pod))),
    "Admission/runtime Pods have not exited",
  );
  return installed.map((item) => `${item.kind}/${item.metadata.name}`).sort();
}

/** A retained machine is not a released Workspace or a failed user action. */
export function maintenanceMachineRetired(row) {
  return (
    row.state === "reconciling" &&
    row.allocation_closed === true &&
    row.allocation_absent === true &&
    ["running", "paused"].includes(row.desired_state) &&
    row.runtime_id === null &&
    row.runtime_name === null &&
    row.runtime_capsule === null &&
    row.agent_activation_id === null &&
    row.terminal_active === false &&
    uuid.test(row.owner_instance_id ?? "") &&
    typeof row.owner_base_url === "string" &&
    row.owner_base_url.length > 0 &&
    row.failure_code === null
  );
}

export function validateRetirementTarget(target, openCapsule) {
  assert(["machine", "elastic"].includes(target.kind), "Unsupported compute retirement kind");
  for (const name of ["id", "allocationId", "tenantId", "projectId", "workspaceId"])
    assert(uuid.test(target[name]), "Invalid compute ownership identity");
  assert(
    typeof target.domainId === "string" && target.domainId.length > 0,
    "Missing Sandbox domain",
  );
  assert(
    uuid.test(target.ownerId ?? "") &&
      typeof target.ownerBaseUrl === "string" &&
      target.ownerBaseUrl.length > 0,
    "Compute retirement requires an existing recorded owner",
  );
  if (target.kind === "machine") {
    assert(
      ["running", "paused"].includes(target.desiredState),
      "User Release must finish through normal lifecycle management",
    );
    assert(
      uuid.test(target.environmentVersionId ?? ""),
      "Machine recovery configuration is missing",
    );
    assert(
      target.agentActivationId === null && target.terminalActive === false,
      "Machine still has active holders",
    );
  }
  const neverIssued = target.creationSpec === null;
  if (neverIssued) {
    assert(
      target.runtimeId === null && target.runtimeName === null && target.capsule === null,
      "Unissued allocation has an unexplained physical target",
    );
    return { ...target, neverIssued: true, nodeId: null };
  }
  assert.equal(
    target.creationSpec?.activationId,
    target.allocationId,
    "Creation allocation changed",
  );
  for (const name of ["tenantId", "projectId", "workspaceId"])
    assert.equal(
      target.creationSpec?.assignment?.[name],
      target[name],
      "Creation ownership changed",
    );
  const sandboxId = target.runtimeName;
  assert(
    typeof sandboxId === "string" && /^[A-Za-z0-9-]{1,128}$/.test(sandboxId),
    "Original native creation remains unresolved",
  );
  if (target.capsule === null && target.providerReceipt) {
    assert(target.providerCreateStartedAt, "Creation receipt lacks its original send permit");
    const receipt = openCapsule(target.providerReceipt),
      instance = receipt.instance;
    assert.equal(receipt.version, 4, "Unsupported native creation receipt");
    assert.equal(receipt.kind, "created", "Native creation was not confirmed");
    assert.equal(receipt.activationId, target.allocationId, "Receipt allocation changed");
    assert.equal(instance?.sandboxId, sandboxId, "Receipt physical identity changed");
    const metadata = instance?.metadata;
    assert.equal(metadata?.["picloud.managed"], "true");
    assert.equal(
      metadata?.["picloud.provider"],
      "cubesandbox",
      "Early maintenance requires a complete Cube creation receipt",
    );
    assert.equal(metadata?.["picloud.workspace_runtime_id"], target.allocationId);
    for (const name of ["tenantId", "projectId", "workspaceId"]) {
      assert.equal(receipt.assignment?.[name], target[name], "Receipt assignment changed");
      const key = {
        tenantId: "picloud.tenant_id",
        projectId: "picloud.project_id",
        workspaceId: "picloud.workspace_id",
      }[name];
      assert.equal(metadata[key], target[name], "Receipt metadata changed");
    }
    return {
      ...target,
      neverIssued: false,
      earlyReceipt: true,
      providerId: "cubesandbox",
      instance,
      nodeId: instance.nodeId ?? null,
      endpoint: null,
    };
  }
  assert(target.capsule !== null, "Settle pending creation before compute maintenance");
  let nodeId = null;
  let providerId = null,
    instance = null,
    endpoint = null;
  if (target.capsule !== null) {
    const capsule = openCapsule(target.capsule);
    const handle = capsule.handle,
      execution = capsule.executionTarget;
    assert.equal(handle?.activationId, target.allocationId, "Capsule allocation changed");
    // Retirement consumes only the stable provider-address contract. It does
    // not adopt a Harness, Guest or a historical private allocation protocol.
    assert.equal(handle?.providerApiVersion, 1, "Unsupported provider address contract");
    assert(
      ["cubesandbox", "boxlite"].includes(handle?.providerId),
      "Unsupported resource provider",
    );
    providerId = handle.providerId;
    assert.equal(handle?.runtimeName, sandboxId, "Capsule sandbox changed");
    if (target.runtimeId !== null)
      assert.equal(handle?.runtimeId, target.runtimeId, "Capsule runtime changed");
    for (const name of ["tenantId", "projectId", "workspaceId"])
      assert.equal(handle?.assignment?.[name], target[name], "Capsule ownership changed");
    assert.equal(execution?.sandboxId, sandboxId, "Capsule execution target changed");
    assert(
      typeof execution.nodeId === "string" &&
        execution.nodeId.length > 0 &&
        execution.nodeId.length <= 256,
      "Capsule recorded node is unavailable",
    );
    nodeId = execution.nodeId;
    instance = capsule.instance;
    endpoint = execution.apiUrl;
    if (providerId === "boxlite") {
      assert(
        instance?.sandboxId === sandboxId &&
          instance.nodeId === nodeId &&
          instance.attachment?.sandboxId === target.allocationId,
        "BoxLite deletion requires its original physical and attachment receipt",
      );
      assert(
        typeof endpoint === "string" && endpoint.length <= 2048,
        "BoxLite endpoint is unavailable",
      );
    }
  }
  return { ...target, neverIssued: false, nodeId, providerId, instance, endpoint };
}

/** Wait for positive process/PG quiescence. Time passing never clears a writer
 * or an owner; PG evaluates lease expiry and every other drain predicate. */
export async function awaitComputeRetirementQuiescence({
  repository,
  assertProcessesStopped,
  signal,
  timeoutMs = 120_000,
  monotonicNow = () => performance.now(),
  sleep = (ms, signal) => delay(ms, undefined, { signal }),
}) {
  assert(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 600_000,
    "Invalid quiescence wait",
  );
  const deadline = monotonicNow() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    try {
      await assertProcessesStopped();
      await repository.assertDrained();
      signal?.throwIfAborted();
      return;
    } catch (cause) {
      signal?.throwIfAborted();
      if (monotonicNow() >= deadline)
        throw new Error("Compute maintenance quiescence remains unconfirmed", { cause });
    }
    await sleep(Math.min(500, Math.max(1, deadline - monotonicNow())), signal);
  }
}

/** Ports expose existing PG authority and native deletion only. No
 * Workspace, Tool, create/resume, direct process or Volume-delete port exists. */
export async function retireComputeForMaintenance({
  repository,
  native,
  assertProcessesStopped,
  openCapsule,
  signal,
  progress = () => {},
}) {
  const cold = async () => {
    signal?.throwIfAborted();
    await assertProcessesStopped();
    await repository.assertDrained();
    signal?.throwIfAborted();
  };
  await cold();
  // Reject unsupported ownership before touching any allocation in this batch.
  const targets = (await repository.listTargets()).map((target) =>
    validateRetirementTarget(target, openCapsule),
  );
  const completed = [];
  for (const target of targets) {
    await cold();
    if (target.earlyReceipt) {
      assert(native.assertCreated, "Confirm native creation completion before maintenance");
      await native.assertCreated(target);
      await cold();
    }
    await repository.beginClose(target);
    // The durable row retains this exact target if any subsequent call fails.
    progress({
      kind: target.kind,
      id: target.id,
      allocationId: target.allocationId,
      phase: "closing",
    });
    if (!target.neverIssued) {
      await cold();
      await repository.assertCurrent(target);
      // The adapter accepts a successful native deletion or a retained matching
      // native delete event. Generic 404, timeouts and probes remain uncertain.
      // Join the admitted request even if operator cancellation arrives.
      await native.destroy(target);
      signal?.throwIfAborted();
    }
    await cold();
    await repository.finishClose(target);
    const receipt = {
      kind: target.kind,
      id: target.id,
      allocationId: target.allocationId,
      workspaceId: target.workspaceId,
      phase: "retired",
    };
    completed.push(receipt);
    progress(receipt);
  }
  return completed;
}
