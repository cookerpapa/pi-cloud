import { expect, it, vi } from "vitest";
import { controlPlaneSnapshot, replaceControlPlane } from "./control-plane-release.mjs";

function fixture() {
  const deployment = {
    metadata: { name: "pi-cloud-control-plane", uid: "deployment" },
    spec: {
      replicas: 1,
      template: { spec: { containers: [{ name: "control-plane", image: "old" }] } },
    },
  };
  const oldPod = {
    metadata: { uid: "old-pod" },
    status: { podIP: "127.0.0.1", containerStatuses: [{ ready: true }] },
  };
  const state = { deployment, autoscalers: [], pods: [oldPod] };
  const phases = [],
    actions = [];
  let receipt;
  const port = {
    observe: vi.fn(async () => structuredClone(state)),
    owners: vi.fn(async () => ["owner"]),
    request: vi.fn(async (r, action) => {
      actions.push(action);
      return { version: 1, requestId: r.id, instanceId: "process", phase: "held" };
    }),
    save: vi.fn(async (r) => {
      receipt = structuredClone(r);
      phases.push(r.phase);
    }),
    stop: vi.fn(async () => {
      actions.push("stop");
      state.deployment.spec.replicas = 0;
      state.pods = [];
    }),
    waitAbsent: vi.fn(async () => {
      actions.push("absent");
    }),
    waitOwners: vi.fn(async () => {
      actions.push("owners-closed");
    }),
    restore: vi.fn(async () => {
      actions.push("restore");
      state.deployment.spec.replicas = 1;
      state.pods = [oldPod];
    }),
    apply: vi.fn(async () => {
      actions.push("helm");
      state.deployment.spec.template.spec.containers[0].image = "new";
      state.deployment.spec.replicas = 1;
    }),
    pause: vi.fn(async () => {}),
  };
  return { state, port, phases, actions, receipt: () => receipt };
}

it("orders the local hold, old Pod exit and PG owner boundary before Helm", async () => {
  const f = fixture();
  await replaceControlPlane(f.port, undefined, "v2");
  expect(f.actions).toEqual(["prepare", "stop", "absent", "owners-closed", "helm"]);
  expect(f.phases).toEqual(["holding", "stopping", "stopped", "applying", "applied"]);
  expect(f.port.restore).not.toHaveBeenCalled();
});
it("a busy Tool timeout cancels the hold and leaves the old process in service", async () => {
  const f = fixture();
  f.port.request.mockImplementation(async (r, action) => ({
    version: 1,
    requestId: r.id,
    instanceId: "process",
    phase: action === "prepare" ? "waiting" : "open",
  }));
  await expect(replaceControlPlane(f.port, undefined, "v2", -1)).rejects.toThrow("did not settle");
  expect(f.port.stop).not.toHaveBeenCalled();
  expect(f.port.apply).not.toHaveBeenCalled();
  expect(f.port.request.mock.calls.at(-1)[1]).toBe("cancel");
  expect(f.receipt().phase).toBe("restored");
});
it("restores the exact old template after a pre-Helm failure", async () => {
  const f = fixture();
  f.port.waitOwners.mockRejectedValueOnce(new Error("temporary PG outage"));
  await expect(replaceControlPlane(f.port, undefined, "v2")).rejects.toThrow("PG outage");
  expect(f.port.restore).toHaveBeenCalledTimes(1);
  expect(f.state.deployment.spec.replicas).toBe(1);
  expect(f.state.deployment.spec.template.spec.containers[0].image).toBe("old");
});
it("does not roll back an uncertain Helm mutation and resumes its same candidate", async () => {
  const f = fixture(),
    apply = f.port.apply.getMockImplementation();
  f.port.apply.mockImplementationOnce(async () => {
    await apply();
    throw new Error("lost Helm reply");
  });
  await expect(replaceControlPlane(f.port, undefined, "v2")).rejects.toThrow("lost Helm reply");
  expect(f.port.restore).not.toHaveBeenCalled();
  expect(f.receipt().phase).toBe("applying");
  const prepareCalls = f.port.request.mock.calls.length;
  await replaceControlPlane(f.port, f.receipt(), "v2");
  expect(f.port.request.mock.calls.length).toBe(prepareCalls);
  expect(f.receipt().phase).toBe("applied");
});
it("can resume after operator loss with zero replicas, but cannot adopt somebody else's stop", async () => {
  const f = fixture();
  const snapshot = controlPlaneSnapshot(f.state.deployment, [], f.state.pods);
  f.state.deployment.spec.replicas = 0;
  f.state.pods = [];
  await expect(replaceControlPlane(f.port, undefined, "v2")).rejects.toThrow(
    "without this candidate",
  );
  await replaceControlPlane(
    f.port,
    { ...snapshot, id: "request", version: "v2", phase: "stopping", owners: ["owner"] },
    "v2",
  );
  expect(f.port.request).not.toHaveBeenCalled();
  expect(f.port.apply).toHaveBeenCalledTimes(1);
});
it("rejects autoscaling, overlap and an unready Pod before touching the deployment", async () => {
  const f = fixture();
  expect(() =>
    controlPlaneSnapshot(
      f.state.deployment,
      [{ spec: { scaleTargetRef: { name: "pi-cloud-control-plane" } } }],
      f.state.pods,
    ),
  ).toThrow("autoscaler");
  expect(() =>
    controlPlaneSnapshot(f.state.deployment, [], [...f.state.pods, ...f.state.pods]),
  ).toThrow("settled");
  f.state.pods[0].status.containerStatuses[0].ready = false;
  await expect(replaceControlPlane(f.port, undefined, "v2")).rejects.toThrow("not ready");
  expect(f.port.stop).not.toHaveBeenCalled();
});
