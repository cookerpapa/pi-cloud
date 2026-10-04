// Characterize an owned VM only. This is a review reproducer, not a success gate.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { OfficialCubeSandboxRuntimeClient } from "../packages/sandbox-control/src/cubesandbox-runtime-client.ts";

if (process.env.PI_CLOUD_LIVE_REVIEW !== "1")
  throw Error("Set PI_CLOUD_LIVE_REVIEW=1 for an owned Cube VM");
const base = "deploy/production/runtime";
const cluster = JSON.parse(await readFile(`${base}/cubesandbox/cluster.json`, "utf8"));
const template = JSON.parse(await readFile(`${base}/cubesandbox/template.json`, "utf8"));
const client = new OfficialCubeSandboxRuntimeClient({
  apiUrl: `http://${cluster.api.host}:${cluster.api.port}`,
  apiKey: (await readFile(`${base}/secrets/cubesandbox-api-key`, "utf8")).trim(),
  proxyNodeIp: cluster.proxy.host,
  proxyPort: cluster.proxy.port,
  proxyScheme: "http",
  sandboxDomain: cluster.sandboxDomain,
  egressProxyIp: "10.255.255.254",
  requestTimeoutMs: 90_000,
});
const allocation = { id: randomUUID(), createBefore: Date.now() + 300_000 };
const report = {
  checkedAt: new Date().toISOString(),
  scope: "one owned real Cube VM; no user VM or Run mutation",
  closeAttempts: [],
  cleanupConfirmed: false,
};
let instance, failure;
try {
  instance = await client.create({
    allocation,
    templateId: template.development.starter.templateId,
    timeoutSeconds: 600,
    metadata: { "picloud.managed": "true", "picloud.workload": "review-paused-allocation" },
    allowInternetAccess: true,
    allowPublicTraffic: false,
  });
  await client.pause(instance.sandboxId);
  assert.equal((await client.read(instance.sandboxId))?.state, "paused");
  for (let i = 0; i < 3; i++) {
    const start = performance.now();
    try {
      const result = await client.allocation(allocation.id, allocation.createBefore, "close");
      report.closeAttempts.push({ phase: result.phase, ms: Math.round(performance.now() - start) });
    } catch (error) {
      report.closeAttempts.push({
        error: error.message,
        ms: Math.round(performance.now() - start),
      });
    }
  }
  report.stateAfterCloseAttempts = (await client.read(instance.sandboxId))?.state ?? "absent";
  report.reproduced =
    report.stateAfterCloseAttempts === "paused" && report.closeAttempts.every((x) => x.error);
} catch (error) {
  failure = error;
} finally {
  // Only our exact allocation: wake it explicitly so existing native cleanup has
  // no paused-VM preflight, then require node-anchored absence before finishing.
  for (let attempt = 0; attempt < 6 && !report.cleanupConfirmed; attempt++) {
    try {
      if (instance && (await client.read(instance.sandboxId))?.state === "paused")
        await client.connect(instance.sandboxId, 600);
      const result = await client.allocation(allocation.id, allocation.createBefore, "close");
      report.cleanupConfirmed =
        result.closed &&
        result.phase === "absent" &&
        (!instance ||
          (await client.observe(instance.sandboxId, instance.nodeId)).presence === "absent");
    } catch {
      await delay(1000);
    }
  }
  await client.close();
  if (failure) report.failure = failure.message;
  await writeFile(
    process.argv[2] ?? "/tmp/pi-cloud-review-20261004/paused-allocation.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
  if (failure || !report.cleanupConfirmed)
    throw failure ?? Error("Owned review allocation cleanup unconfirmed");
}
