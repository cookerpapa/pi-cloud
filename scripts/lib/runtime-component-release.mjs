import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { digest } from "./component-release.mjs";

export const runtimeReplacementTargets = {
  "tool-host": {
    role: "tool-host",
    contract: "toolHostReplacement",
    port: 4310,
    path: "/internal/v1/tools/drain",
  },
  "session-decoder": {
    role: "session-runtime",
    contract: "sessionRuntimeReplacement",
    port: 3000,
    path: "/internal/v1/session-publication/replacement",
  },
};
function assertRole(role) {
  assert(["tool-host", "session-runtime"].includes(role), "Unsupported runtime replacement role");
}

export function runtimeComponentSnapshot(role, deployment, autoscalers, pods) {
  assertRole(role);
  assert.equal(deployment.metadata.name, `pi-cloud-${role}`);
  assert.equal(
    deployment.spec.replicas,
    1,
    "Scoped Runtime component release requires one serving replica",
  );
  assert(
    !autoscalers.some((h) => h.spec.scaleTargetRef.name === deployment.metadata.name),
    "Scoped Runtime component release does not support an autoscaler",
  );
  assert.equal(pods.length, 1, "Runtime component Pods are not settled");
  const pod = pods[0];
  assert(
    !pod.metadata.deletionTimestamp &&
      pod.status.podIP &&
      pod.status.containerStatuses?.every((c) => c.ready),
    "Runtime component Pod is not ready",
  );
  return {
    uid: deployment.metadata.uid,
    template: digest(deployment.spec.template),
    replicas: 1,
    podUid: pod.metadata.uid,
    podIp: pod.status.podIP,
  };
}

export function sameRuntimeComponent(role, receipt, deployment) {
  assertRole(role);
  assert.equal(deployment.metadata.name, `pi-cloud-${role}`);
  assert.equal(
    deployment.metadata.uid,
    receipt.uid,
    "Runtime component Deployment identity changed",
  );
  assert.equal(
    digest(deployment.spec.template),
    receipt.template,
    "Runtime component template changed",
  );
}

/** Operator journal only. Helm/PG/Kafka keep their original authorities. */
export async function replaceRuntimeComponent(role, port, prior, version, budgetMs = 300_000) {
  assertRole(role);
  let receipt = prior;
  if (receipt) assert.equal(receipt.role, role, "Replacement receipt targets another role");
  const save = async (phase) => {
    const next = { ...receipt, phase };
    await port.save(next);
    receipt = next;
  };
  try {
    if (receipt?.phase === "applying" || receipt?.phase === "applied") {
      assert.equal(receipt.version, version);
      const current = await port.observe();
      assert.equal(current.deployment.metadata.name, `pi-cloud-${role}`);
      assert.equal(
        current.deployment.metadata.uid,
        receipt.uid,
        "Runtime component Deployment identity changed",
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
        ...runtimeComponentSnapshot(role, state.deployment, state.autoscalers, state.pods),
        version,
        id: randomUUID(),
        role,
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
          "Runtime component restarted while draining",
        );
        if (status.phase === "held") break;
        assert.equal(status.phase, "waiting");
        assert(
          Date.now() < end,
          "Bound operations and control Tools did not settle; keep the current version serving",
        );
        await (port.pause ?? delay)(250);
      }
      const fresh = await port.observe();
      sameRuntimeComponent(role, receipt, fresh.deployment);
      assert.equal(
        fresh.pods.find((pod) => !pod.metadata.deletionTimestamp)?.metadata.uid,
        receipt.podUid,
        "Runtime component Pod changed before replacement",
      );
      await save("stopping");
      await port.stop();
    } else {
      assert(
        receipt && ["stopping", "stopped"].includes(receipt.phase),
        "Runtime component is stopped without this candidate's replacement receipt",
      );
      assert.equal(receipt.version, version);
      sameRuntimeComponent(role, receipt, state.deployment);
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
      sameRuntimeComponent(role, receipt, current.deployment);
      if (current.deployment.spec.replicas === 0) {
        await port.waitAbsent();
        await port.restore();
      } else assert.equal(current.deployment.spec.replicas, receipt.replicas);
      await save("restored");
    }
    throw error;
  }
}
