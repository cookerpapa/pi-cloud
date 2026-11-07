import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  assertRetirementProcessesStopped,
  awaitComputeRetirementQuiescence,
  maintenanceMachineRetired,
  retireComputeForMaintenance,
  validateRetirementTarget,
} from "./compute-retirement.mjs";

function fixture(desiredState = "running", kind = "machine") {
  const allocationId = randomUUID(),
    tenantId = randomUUID(),
    projectId = randomUUID(),
    workspaceId = randomUUID();
  let row = {
    kind,
    id: kind === "machine" ? randomUUID() : allocationId,
    allocationId,
    tenantId,
    projectId,
    workspaceId,
    domainId: "owned-domain",
    ownerId: randomUUID(),
    ownerBaseUrl: "http://old-owner.test",
    allocationProtocol: 1,
    creationSpec: { activationId: allocationId, assignment: { tenantId, projectId, workspaceId } },
    createBefore: 1_800_000_000_000,
    deadlineText: "2027-01-15 08:00:00.000123+00",
    runtimeId: randomUUID(),
    runtimeName: allocationId.replaceAll("-", ""),
    capsule: "private-capsule",
    state: kind === "machine" ? "ready" : "allocated",
    allocationClosed: false,
    desiredState,
    intentRevision: "4",
    generation: "2",
    allocationAbsent: false,
    environmentVersionId: randomUUID(),
    agentActivationId: null,
    terminalActive: false,
  };
  const original = structuredClone(row),
    events = [],
    abort = new AbortController();
  const capsule = {
    version: 2,
    handle: {
      activationId: allocationId,
      allocation: { createBefore: row.createBefore },
      runtimeId: row.runtimeId,
      runtimeName: row.runtimeName,
      assignment: row.creationSpec.assignment,
    },
    executionTarget: { sandboxId: row.runtimeName, nodeId: "recorded-node" },
  };
  let retired = false,
    physicallyClosed = false,
    cold = true;
  const exact = (expected) => {
    assert.equal(row.allocationId, expected.allocationId, "allocation changed");
    assert.equal(row.intentRevision, expected.intentRevision, "intent changed");
    assert.equal(row.ownerId, expected.ownerId, "owner changed");
  };
  const repository = {
    assertDrained: vi.fn(async () => {
      assert(cold, "owner still active");
    }),
    listTargets: vi.fn(async () => (retired ? [] : [structuredClone(row)])),
    beginClose: vi.fn(async (value) => {
      exact(value);
      row.allocationClosed = true;
      row.state = kind === "machine" ? "reconciling" : "cleaning";
      events.push("pg-close");
    }),
    assertCurrent: vi.fn(async (value) => {
      exact(value);
      assert(row.allocationClosed);
    }),
    finishClose: vi.fn(async (value) => {
      exact(value);
      assert(physicallyClosed || value.neverIssued, "physical proof missing");
      row.runtimeId = row.runtimeName = row.capsule = null;
      row.allocationAbsent = true;
      row.state = kind === "machine" ? "reconciling" : "released";
      retired = true;
      events.push("pg-absent");
    }),
  };
  const receipt = (closed) => ({
    allocationId,
    createBefore: row.createBefore,
    sandboxId: original.runtimeName,
    nodeId: "recorded-node",
    closed,
    phase: closed ? "absent" : "ready",
  });
  const native = {
    allocation: vi.fn(async (_id, _deadline, action) => {
      if (action === "close") {
        assert(row.allocationClosed);
        physicallyClosed = true;
        events.push("native-close");
      }
      return receipt(physicallyClosed);
    }),
    observe: vi.fn(async () => {
      events.push("node-absent");
      return {
        runtimeName: original.runtimeName,
        nodeId: "recorded-node",
        presence: "absent",
        state: "unknown",
      };
    }),
  };
  const options = {
    repository,
    native,
    assertProcessesStopped: vi.fn(async () => {}),
    openCapsule: () => capsule,
    signal: abort.signal,
    sleep: async () => {},
  };
  return {
    options,
    repository,
    native,
    row,
    original,
    events,
    abort,
    receipt,
    activeOwner() {
      cold = false;
    },
    run: () => retireComputeForMaintenance(options),
  };
}

it.each(["running", "paused"])(
  "preserves stable machine and Workspace intent for %s",
  async (desired) => {
    const f = fixture(desired);
    expect(await f.run()).toHaveLength(1);
    expect(f.events).toEqual(["pg-close", "native-close", "node-absent", "pg-absent"]);
    for (const name of [
      "id",
      "workspaceId",
      "tenantId",
      "projectId",
      "desiredState",
      "intentRevision",
      "generation",
      "allocationId",
      "creationSpec",
      "createBefore",
      "ownerId",
    ])
      expect(f.row[name]).toEqual(f.original[name]);
    expect(f.row).toMatchObject({
      state: "reconciling",
      allocationClosed: true,
      allocationAbsent: true,
      runtimeId: null,
      runtimeName: null,
      capsule: null,
    });
    expect(await f.run()).toEqual([]);
    expect(f.native.allocation.mock.calls.filter((call) => call[2] === "close")).toHaveLength(1);
  },
);

it("retains the exact cleanup target after a lost native close reply", async () => {
  const f = fixture(),
    normal = f.native.allocation.getMockImplementation();
  f.native.allocation.mockImplementationOnce(normal).mockImplementationOnce(async (...args) => {
    await normal(...args);
    throw new Error("lost close reply");
  });
  await expect(f.run()).rejects.toThrow("lost close reply");
  expect(f.row).toMatchObject({
    allocationClosed: true,
    runtimeId: f.original.runtimeId,
    capsule: f.original.capsule,
  });
  expect(f.repository.finishClose).not.toHaveBeenCalled();
  await f.run();
  expect(f.row.runtimeId).toBeNull();
});

it("does not repeat physical effects after a lost final PG acknowledgement", async () => {
  const f = fixture(),
    commit = f.repository.finishClose.getMockImplementation();
  f.repository.finishClose.mockImplementationOnce(async (value) => {
    await commit(value);
    throw new Error("lost PG commit reply");
  });
  await expect(f.run()).rejects.toThrow("lost PG commit reply");
  expect(await f.run()).toEqual([]);
  expect(f.native.allocation.mock.calls.filter((call) => call[2] === "close")).toHaveLength(1);
  expect(f.row.desiredState).toBe("running");
});

it.each(["unavailable", "present"])(
  "never settles %s recorded-node observation",
  async (presence) => {
    const f = fixture();
    f.native.observe.mockResolvedValue({
      runtimeName: f.row.runtimeName,
      nodeId: "recorded-node",
      presence,
      state: "unknown",
    });
    await expect(f.run()).rejects.toThrow("physical absence is unconfirmed");
    expect(f.repository.finishClose).not.toHaveBeenCalled();
    expect(f.row.capsule).toBe(f.original.capsule);
  },
);

it("refuses changed native placement and leaves PG admission closed", async () => {
  const f = fixture();
  f.native.allocation.mockResolvedValue({ ...f.receipt(false), nodeId: "replacement-node" });
  await expect(f.run()).rejects.toThrow("recorded node changed");
  expect(f.row.allocationClosed).toBe(true);
  expect(f.native.allocation.mock.calls.every((call) => call[2] === "get")).toBe(true);
  expect(f.repository.finishClose).not.toHaveBeenCalled();
});

it("retains the capsule node after native terminal receipt collection", async () => {
  const f = fixture(),
    normal = f.native.allocation.getMockImplementation();
  f.native.allocation.mockImplementation(async (...args) => {
    const receipt = await normal(...args);
    delete receipt.nodeId;
    if (args[2] === "get") receipt.phase = "missing";
    return receipt;
  });
  await f.run();
  expect(f.native.observe).toHaveBeenCalledWith(f.original.runtimeName, "recorded-node");
  expect(f.events).toEqual(["pg-close", "native-close", "node-absent", "pg-absent"]);
});

it.each(["allocationId", "intentRevision", "ownerId"])(
  "fences stale %s after a native reply",
  async (field) => {
    const f = fixture(),
      normal = f.native.allocation.getMockImplementation();
    f.native.allocation.mockImplementation(async (...args) => {
      const result = await normal(...args);
      if (args[2] === "close") f.row[field] = field === "intentRevision" ? "5" : randomUUID();
      return result;
    });
    await expect(f.run()).rejects.toThrow("changed");
    expect(f.row.runtimeId).toBe(f.original.runtimeId);
    expect(f.row.workspaceId).toBe(f.original.workspaceId);
  },
);

it("rechecks cold ownership before issuing native closure", async () => {
  const f = fixture(),
    normal = f.native.allocation.getMockImplementation();
  f.native.allocation.mockImplementation(async (...args) => {
    const result = await normal(...args);
    f.activeOwner();
    return result;
  });
  await expect(f.run()).rejects.toThrow("owner still active");
  expect(f.native.allocation.mock.calls).toHaveLength(1);
  expect(f.row.allocationClosed).toBe(true);
  expect(f.row.runtimeId).toBe(f.original.runtimeId);
});

it("retains cleanup ownership while native closure remains pending", async () => {
  const f = fixture();
  let elapsed = 0;
  Object.assign(f.options, {
    timeoutMs: 1000,
    monotonicNow: () => elapsed,
    sleep: async (ms) => {
      elapsed += ms;
    },
  });
  f.native.allocation.mockImplementation(async (_id, _deadline, action) =>
    action === "get" ? f.receipt(false) : { ...f.receipt(true), phase: "closing" },
  );
  await expect(f.run()).rejects.toThrow("closure remains unconfirmed");
  expect(f.repository.finishClose).not.toHaveBeenCalled();
  expect(f.native.observe).not.toHaveBeenCalled();
  expect(f.row.capsule).toBe(f.original.capsule);
});

it("joins an admitted close but retains ownership when cancellation arrives", async () => {
  const f = fixture(),
    normal = f.native.allocation.getMockImplementation();
  f.native.allocation.mockImplementation(async (...args) => {
    const result = await normal(...args);
    if (args[2] === "close") f.abort.abort(new Error("owned cancellation"));
    return result;
  });
  await expect(f.run()).rejects.toThrow("owned cancellation");
  expect(f.events).toEqual(["pg-close", "native-close"]);
  expect(f.repository.finishClose).not.toHaveBeenCalled();
  expect(f.row.capsule).toBe(f.original.capsule);
});

it("closes never-issued owned admission without inventing a VM action", async () => {
  const f = fixture("running", "elastic");
  Object.assign(f.row, {
    creationSpec: null,
    createBefore: null,
    runtimeId: null,
    runtimeName: null,
    capsule: null,
  });
  await f.run();
  expect(f.native.allocation).not.toHaveBeenCalled();
  expect(f.row.state).toBe("released");
});

it("rejects a bad capsule or user Release before any allocation mutation", async () => {
  const f = fixture();
  f.options.openCapsule = () => ({ version: 2, handle: { activationId: randomUUID() } });
  await expect(f.run()).rejects.toThrow("Capsule allocation changed");
  expect(f.repository.beginClose).not.toHaveBeenCalled();
  expect(() =>
    validateRetirementTarget({ ...f.original, desiredState: "released" }, () => {}),
  ).toThrow("User Release");
});

it("checks actual old and new workloads without a compatibility runtime alias", () => {
  const workload = (role, replicas = 0) => ({
    kind: "Deployment",
    metadata: { name: role, labels: { "app.kubernetes.io/component": role } },
    spec: { replicas },
  });
  const old = [workload("control-plane"), workload("trusted-pi-worker")];
  expect(assertRetirementProcessesStopped({ workloads: old, pods: [] })).toHaveLength(2);
  expect(
    assertRetirementProcessesStopped({
      workloads: [...old, workload("session-runtime")],
      pods: [],
    }),
  ).toHaveLength(3);
  expect(() =>
    assertRetirementProcessesStopped({
      workloads: [...old, workload("session-runtime", 1)],
      pods: [],
    }),
  ).toThrow("not stopped");
  expect(() =>
    assertRetirementProcessesStopped({ workloads: old, pods: [workload("trusted-pi-worker")] }),
  ).toThrow("not exited");
});

it("waits for PG-confirmed owner expiry without clearing any ownership itself", async () => {
  let elapsed = 0;
  const repository = {
    assertDrained: vi.fn(async () => {
      if (elapsed < 1000) throw new Error("owner lease is current");
    }),
  };
  const stopped = vi.fn(async () => {});
  await awaitComputeRetirementQuiescence({
    repository,
    assertProcessesStopped: stopped,
    monotonicNow: () => elapsed,
    sleep: async (ms) => {
      elapsed += ms;
    },
  });
  expect(elapsed).toBe(1000);
  expect(repository.assertDrained).toHaveBeenCalledTimes(3);
  expect(stopped).toHaveBeenCalledTimes(3);
  await expect(
    awaitComputeRetirementQuiescence({
      repository: {
        assertDrained: async () => {
          throw new Error("unsealed writer");
        },
      },
      assertProcessesStopped: stopped,
      timeoutMs: 1000,
      monotonicNow: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
      },
    }),
  ).rejects.toThrow("quiescence remains unconfirmed");
});

it("recognizes only a verified retained retirement shape", () => {
  const row = {
    state: "reconciling",
    allocation_closed: true,
    allocation_absent: true,
    desired_state: "paused",
    runtime_id: null,
    runtime_name: null,
    runtime_capsule: null,
    agent_activation_id: null,
    terminal_active: false,
    owner_instance_id: randomUUID(),
    owner_base_url: "http://expired-owner.test",
    failure_code: null,
  };
  expect(maintenanceMachineRetired(row)).toBe(true);
  for (const change of [
    { allocation_absent: false },
    { allocation_closed: false },
    { runtime_capsule: "retained-target" },
    { terminal_active: true },
    { desired_state: "released" },
  ])
    expect(maintenanceMachineRetired({ ...row, ...change })).toBe(false);
});
