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
  assert.equal(target.allocationProtocol, 1, "Allocation lacks maintained close authorization");
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
  const neverIssued = target.creationSpec === null && target.createBefore === null;
  if (neverIssued) {
    assert(
      target.runtimeId === null && target.runtimeName === null && target.capsule === null,
      "Unissued allocation has an unexplained physical target",
    );
    return { ...target, neverIssued: true, nodeId: null };
  }
  assert(
    Number.isSafeInteger(target.createBefore) && target.createBefore > 0,
    "Missing creation deadline",
  );
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
  const sandboxId = target.allocationId.replaceAll("-", "");
  if (target.runtimeName !== null)
    assert.equal(target.runtimeName, sandboxId, "Recorded sandbox changed");
  let nodeId = null;
  if (target.capsule !== null) {
    const capsule = openCapsule(target.capsule);
    assert.equal(capsule?.version, 2, "Unsupported recorded recovery capsule");
    const handle = capsule.handle,
      execution = capsule.executionTarget;
    assert.equal(handle?.activationId, target.allocationId, "Capsule allocation changed");
    assert.equal(handle?.allocation?.createBefore, target.createBefore, "Capsule deadline changed");
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
  }
  return { ...target, neverIssued: false, nodeId };
}

function placement(target, receipt, knownNode) {
  assert.equal(receipt?.allocationId, target.allocationId, "Native allocation identity changed");
  assert.equal(receipt.createBefore, target.createBefore, "Native creation deadline changed");
  assert(
    typeof receipt.closed === "boolean" &&
      ["missing", "pending", "creating", "ready", "failed", "closing", "absent"].includes(
        receipt.phase,
      ),
    "Invalid native allocation receipt",
  );
  if (receipt.sandboxId !== undefined)
    assert.equal(
      receipt.sandboxId,
      target.allocationId.replaceAll("-", ""),
      "Native physical identity changed",
    );
  // Native terminal receipts may already have been collected. A missing route
  // cannot replace the recorded capsule's node, nor prove physical absence;
  // that exact node is still observed after the original admission is closed.
  if (knownNode !== null && receipt.nodeId !== undefined)
    assert.equal(receipt.nodeId, knownNode, "Native recorded node changed");
  const node = knownNode ?? receipt.nodeId ?? null;
  if (node !== null)
    assert(
      typeof node === "string" && node.length > 0 && node.length <= 256,
      "Invalid native node",
    );
  if (receipt.phase === "absent")
    assert.equal(receipt.closed, true, "Native absence lacks closed admission");
  return node;
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

/** Ports expose existing PG authority and native allocation closure only. No
 * Workspace, Tool, create/resume, direct process or Volume-delete port exists. */
export async function retireComputeForMaintenance({
  repository,
  native,
  assertProcessesStopped,
  openCapsule,
  signal,
  progress = () => {},
  timeoutMs = 120_000,
  monotonicNow = () => performance.now(),
  sleep = (ms, signal) => delay(ms, undefined, { signal }),
}) {
  assert(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 600_000,
    "Invalid retirement wait",
  );
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
      const current = await native.allocation(target.allocationId, target.createBefore, "get");
      let nodeId = placement(target, current, target.nodeId);
      if (
        nodeId === null &&
        (target.runtimeId !== null || target.runtimeName !== null || target.capsule !== null)
      )
        throw new Error("Recorded physical allocation has no verifiable node");
      const deadline = monotonicNow() + timeoutMs;
      for (;;) {
        await cold();
        await repository.assertCurrent(target);
        if (monotonicNow() >= deadline)
          throw new Error("Native allocation closure remains unconfirmed");
        // Join the native call even on cancellation; never leave a detached effect.
        const closed = await native.allocation(target.allocationId, target.createBefore, "close");
        nodeId = placement(target, closed, nodeId);
        signal?.throwIfAborted();
        if (closed.closed && closed.phase === "absent") {
          if (nodeId !== null) {
            const absent = await native.observe(target.allocationId.replaceAll("-", ""), nodeId);
            assert.equal(
              absent?.runtimeName,
              target.allocationId.replaceAll("-", ""),
              "Absence target changed",
            );
            assert.equal(absent.nodeId, nodeId, "Absence node changed");
            assert.equal(
              absent.presence,
              "absent",
              "Recorded-node physical absence is unconfirmed",
            );
          }
          break;
        }
        if (monotonicNow() >= deadline)
          throw new Error("Native allocation closure remains unconfirmed");
        await sleep(Math.min(1000, Math.max(1, deadline - monotonicNow())), signal);
      }
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
