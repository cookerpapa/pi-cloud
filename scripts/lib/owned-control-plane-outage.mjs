import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { kubectl } from "./production-kubernetes.mjs";

const target = "deployment/pi-cloud-control-plane";
const templateHash = (value) =>
  createHash("sha256").update(JSON.stringify(value.spec.template)).digest("hex");

export function outageReceipt(deployment, restoreAt) {
  assert.equal(deployment.kind, "Deployment");
  assert.equal(deployment.metadata.name, "pi-cloud-control-plane");
  assert(deployment.spec.replicas > 0, "Control Plane was already stopped");
  return {
    uid: deployment.metadata.uid,
    replicas: deployment.spec.replicas,
    template: templateHash(deployment),
    restoreAt,
    restored: false,
  };
}

/** Restores only the stopped deployment observed by this owned fault. */
export function restoreControlPlane(receipt, invoke = kubectl) {
  const current = JSON.parse(invoke(["get", target, "-o", "json"]));
  assert.equal(current.metadata.uid, receipt.uid, "Control Plane identity changed");
  assert.equal(templateHash(current), receipt.template, "Control Plane template changed");
  if (current.spec.replicas === receipt.replicas) return;
  assert.equal(current.spec.replicas, 0, "Another operator changed the replica count");
  invoke(
    ["scale", target, "--current-replicas=0", `--replicas=${receipt.replicas}`, "--timeout=20s"],
    { timeout: 25_000 },
  );
}

export async function armControlPlaneRestore(path, restoreAt) {
  const deployment = JSON.parse(kubectl(["get", target, "-o", "json"]));
  const autoscalers = JSON.parse(kubectl(["get", "hpa", "-o", "json"])).items;
  assert(
    !autoscalers.some((item) => item.spec.scaleTargetRef.name === deployment.metadata.name),
    "An autoscaler controls this deployment; refusing the replica fault",
  );
  const receipt = outageReceipt(deployment, restoreAt);
  await writeFile(path, JSON.stringify(receipt), { mode: 0o600, flag: "wx" });
  const watchdog = spawn(process.execPath, [fileURLToPath(import.meta.url), "--watch", path], {
    detached: true,
    stdio: "ignore",
    env: process.env,
  });
  await new Promise((resolve, reject) => {
    watchdog.once("spawn", resolve);
    watchdog.once("error", reject);
  });
  watchdog.unref();
  return {
    receipt,
    selector: Object.entries(deployment.spec.selector.matchLabels)
      .map(([key, value]) => `${key}=${value}`)
      .join(","),
    async restore() {
      restoreControlPlane(receipt);
      await writeFile(path, JSON.stringify({ ...receipt, restored: true }), { mode: 0o600 });
    },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--watch") {
  const path = process.argv[3];
  // Independent of the acceptance process: its crash must not leave replicas at zero.
  for (;;) {
    const receipt = JSON.parse(await readFile(path, "utf8"));
    if (receipt.restored) break;
    if (Date.now() >= receipt.restoreAt) {
      restoreControlPlane(receipt);
      await writeFile(path, JSON.stringify({ ...receipt, restored: true, watchdog: true }), {
        mode: 0o600,
      });
      break;
    }
    await delay(Math.min(1000, receipt.restoreAt - Date.now()));
  }
}
