import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { digest } from "./component-release.mjs";

export async function createReplacementDatabase(connectionString) {
  const { createDatabase } = await import("../../packages/database/src/index.ts");
  // The operator only reads owner metadata. The database client deliberately
  // treats read and transaction-checkout budgets as mutually exclusive modes.
  return createDatabase({ connectionString, maxConnections: 1, readTimeoutMs: 5_000 });
}

export function controlPlaneSnapshot(deployment, autoscalers, pods) {
  assert.equal(deployment.metadata.name, "pi-cloud-control-plane");
  assert.equal(
    deployment.spec.replicas,
    1,
    "Scoped Control Plane release requires one serving replica",
  );
  assert(
    !autoscalers.some((h) => h.spec.scaleTargetRef.name === deployment.metadata.name),
    "Scoped Control Plane release does not support an autoscaler",
  );
  assert.equal(pods.length, 1, "Control Plane Pods are not settled");
  const pod = pods[0];
  assert(
    !pod.metadata.deletionTimestamp &&
      pod.status.podIP &&
      pod.status.containerStatuses?.every((c) => c.ready),
    "Control Plane Pod is not ready",
  );
  return {
    uid: deployment.metadata.uid,
    template: digest(deployment.spec.template),
    replicas: 1,
    podUid: pod.metadata.uid,
    podIp: pod.status.podIP,
  };
}

export function sameControlPlane(receipt, deployment) {
  assert.equal(deployment.metadata.uid, receipt.uid, "Control Plane Deployment identity changed");
  assert.equal(
    digest(deployment.spec.template),
    receipt.template,
    "Control Plane template changed",
  );
}

/** Operator journal only. Helm/PG/Kafka keep their original authorities. */
export async function replaceControlPlane(port, prior, version, budgetMs = 300_000) {
  let receipt = prior;
  const save = async (phase) => {
    const next = { ...receipt, phase };
    await port.save(next);
    receipt = next;
  };
  try {
    if (receipt?.phase === "applying" || receipt?.phase === "applied") {
      assert.equal(receipt.version, version);
      const current = await port.observe();
      assert.equal(
        current.deployment.metadata.uid,
        receipt.uid,
        "Control Plane Deployment identity changed",
      );
      assert(
        !current.autoscalers.some(
          (h) => h.spec.scaleTargetRef.name === current.deployment.metadata.name,
        ),
        "An autoscaler now controls this deployment",
      );
      // Helm may already have applied while its caller lost the reply. The
      // enclosing operator checks the actual full manifest before this call.
      await port.apply();
      await save("applied");
      return receipt;
    }
    const state = await port.observe();
    if (state.deployment.spec.replicas === 1) {
      receipt = {
        ...controlPlaneSnapshot(state.deployment, state.autoscalers, state.pods),
        version,
        id: randomUUID(),
        owners: await port.owners(),
        phase: "holding",
        startedAt: new Date().toISOString(),
      };
      await port.save(receipt);
      const end = Date.now() + budgetMs;
      for (;;) {
        const status = await port.request(receipt, "prepare");
        assert.equal(status.version, 1, "Install the matched replacement contract first");
        assert.equal(status.requestId, receipt.id);
        assert(typeof status.instanceId === "string" && status.instanceId.length > 0);
        receipt.instanceId ??= status.instanceId;
        assert.equal(
          status.instanceId,
          receipt.instanceId,
          "Control Plane restarted while draining",
        );
        if (status.phase === "held") break;
        assert.equal(status.phase, "waiting");
        assert(Date.now() < end, "Control Tools did not settle; keep the current version serving");
        await (port.pause ?? delay)(250);
      }
      const fresh = await port.observe();
      sameControlPlane(receipt, fresh.deployment);
      assert.equal(
        controlPlaneSnapshot(fresh.deployment, fresh.autoscalers, fresh.pods).podUid,
        receipt.podUid,
        "Control Plane Pod changed before replacement",
      );
      await save("stopping");
      await port.stop();
    } else {
      assert(
        receipt && ["stopping", "stopped"].includes(receipt.phase),
        "Control Plane is stopped without this candidate's replacement receipt",
      );
      assert.equal(receipt.version, version);
      sameControlPlane(receipt, state.deployment);
      assert.equal(state.deployment.spec.replicas, 0);
    }
    await port.waitAbsent();
    await port.waitOwners(receipt.owners);
    await save("stopped");
    await save("applying"); // Persist before Helm can mutate the template.
    await port.apply();
    await save("applied");
    return receipt;
  } catch (error) {
    if (receipt && !["applying", "applied"].includes(receipt.phase)) {
      await port.request(receipt, "cancel").catch(() => {});
      const current = await port.observe();
      sameControlPlane(receipt, current.deployment);
      if (current.deployment.spec.replicas === 0) {
        await port.waitAbsent();
        await port.waitOwners(receipt.owners);
        await port.restore();
      } else assert.equal(current.deployment.spec.replicas, receipt.replicas);
      await save("restored");
    }
    throw error;
  }
}
