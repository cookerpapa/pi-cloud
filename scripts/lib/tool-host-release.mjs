import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { digest } from "./component-release.mjs";

export function toolHostSnapshot(deployment, autoscalers, pods) {
  assert.equal(deployment.metadata.name, "pi-cloud-tool-host");
  assert.equal(
    deployment.spec.replicas,
    1,
    "Scoped Tool host release requires one serving replica",
  );
  assert(
    !autoscalers.some((h) => h.spec.scaleTargetRef.name === deployment.metadata.name),
    "Scoped Tool host release does not support an autoscaler",
  );
  assert.equal(pods.length, 1, "Tool host Pods are not settled");
  const pod = pods[0];
  assert(
    !pod.metadata.deletionTimestamp &&
      pod.status.podIP &&
      pod.status.containerStatuses?.every((c) => c.ready),
    "Tool host Pod is not ready",
  );
  return {
    uid: deployment.metadata.uid,
    template: digest(deployment.spec.template),
    replicas: 1,
    podUid: pod.metadata.uid,
    podIp: pod.status.podIP,
  };
}

export function sameToolHost(receipt, deployment) {
  assert.equal(deployment.metadata.name, "pi-cloud-tool-host");
  assert.equal(deployment.metadata.uid, receipt.uid, "Tool host Deployment identity changed");
  assert.equal(digest(deployment.spec.template), receipt.template, "Tool host template changed");
}

/** Operator journal only. Helm/PG/Kafka keep their original authorities. */
export async function replaceToolHost(port, prior, version, budgetMs = 300_000) {
  let receipt = prior;
  if (receipt) assert.equal(receipt.role, "tool-host", "Replacement receipt targets another role");
  const save = async (phase) => {
    const next = { ...receipt, phase };
    await port.save(next);
    receipt = next;
  };
  try {
    if (receipt?.phase === "applying" || receipt?.phase === "applied") {
      assert.equal(receipt.version, version);
      const current = await port.observe();
      assert.equal(current.deployment.metadata.name, "pi-cloud-tool-host");
      assert.equal(
        current.deployment.metadata.uid,
        receipt.uid,
        "Tool host Deployment identity changed",
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
        ...toolHostSnapshot(state.deployment, state.autoscalers, state.pods),
        version,
        id: randomUUID(),
        role: "tool-host",
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
        assert.equal(status.instanceId, receipt.instanceId, "Tool host restarted while draining");
        if (status.phase === "held") break;
        assert.equal(status.phase, "waiting");
        assert(
          Date.now() < end,
          "Bound operations and control Tools did not settle; keep the current version serving",
        );
        await (port.pause ?? delay)(250);
      }
      const fresh = await port.observe();
      sameToolHost(receipt, fresh.deployment);
      assert.equal(
        fresh.pods.find((pod) => !pod.metadata.deletionTimestamp)?.metadata.uid,
        receipt.podUid,
        "Tool host Pod changed before replacement",
      );
      await save("stopping");
      await port.stop();
    } else {
      assert(
        receipt && ["stopping", "stopped"].includes(receipt.phase),
        "Tool host is stopped without this candidate's replacement receipt",
      );
      assert.equal(receipt.version, version);
      sameToolHost(receipt, state.deployment);
      assert.equal(state.deployment.spec.replicas, 0);
    }
    await port.waitAbsent();
    await save("stopped");
    await save("applying"); // Persist before Helm can mutate the template.
    await port.apply();
    await save("applied");
    return receipt;
  } catch (error) {
    if (receipt && !["applying", "applied"].includes(receipt.phase)) {
      await port.request(receipt, "cancel").catch(() => {});
      const current = await port.observe();
      sameToolHost(receipt, current.deployment);
      if (current.deployment.spec.replicas === 0) {
        await port.waitAbsent();
        await port.restore();
      } else assert.equal(current.deployment.spec.replicas, receipt.replicas);
      await save("restored");
    }
    throw error;
  }
}
