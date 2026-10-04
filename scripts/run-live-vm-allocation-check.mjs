import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { OfficialCubeSandboxRuntimeClient } from "../packages/sandbox-control/src/cubesandbox-runtime-client.ts";

if (process.env.PI_CLOUD_LIVE_VM_ALLOCATION_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_VM_ALLOCATION_CHECK=1 for owned real Cube allocation failure tests",
  );
const runtime = "deploy/production/runtime";
const cluster = JSON.parse(await readFile(`${runtime}/cubesandbox/cluster.json`, "utf8"));
const template = JSON.parse(await readFile(`${runtime}/cubesandbox/template.json`, "utf8"));
const key = (await readFile(`${runtime}/secrets/cubesandbox-api-key`, "utf8")).trim();
const upstream = `http://${cluster.api.host}:${cluster.api.port}`;
const report = { checkedAt: new Date().toISOString(), accepted: false, cases: [] };
const inputs = [];
let failure,
  loseNextReply = false,
  forwardedCreates = 0;
const proxy = createServer(async (req, res) => {
  try {
    if (req.headers.authorization !== `Bearer ${key}`) {
      res.writeHead(401);
      res.end();
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const response = await fetch(new URL(req.url, upstream), {
      method: req.method,
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      ...(body.length ? { body } : {}),
      signal: AbortSignal.timeout(120000),
    });
    const bytes = Buffer.from(await response.arrayBuffer());
    if (req.url === "/sandboxes" && req.method === "POST") {
      forwardedCreates++;
      if (loseNextReply && response.ok) {
        loseNextReply = false;
        req.socket.destroy();
        return;
      }
    }
    res.writeHead(response.status, { "content-type": "application/json" });
    res.end(bytes);
  } catch {
    res.destroy();
  }
});
await new Promise((ok) => proxy.listen(0, "127.0.0.1", ok));
const client = new OfficialCubeSandboxRuntimeClient({
  apiUrl: `http://127.0.0.1:${proxy.address().port}`,
  apiKey: key,
  proxyNodeIp: cluster.proxy.host,
  proxyPort: cluster.proxy.port,
  proxyScheme: "http",
  sandboxDomain: cluster.sandboxDomain,
  egressProxyIp: "10.255.255.254",
  requestTimeoutMs: 90000,
});
function input() {
  const value = {
    allocation: { id: randomUUID(), createBefore: Date.now() + 300000 },
    templateId: template.development?.starter?.templateId ?? template.agent.templateId,
    timeoutSeconds: 120,
    metadata: { "picloud.managed": "true", "picloud.workload": "allocation-acceptance" },
    allowInternetAccess: true,
    allowPublicTraffic: false,
  };
  inputs.push(value);
  return value;
}
async function until(fn, label, ms = 180000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(100);
  }
  throw Error(`Timed out: ${label}`);
}
async function closed(value) {
  return until(async () => {
    try {
      const s = await client.allocation(
        value.allocation.id,
        value.allocation.createBefore,
        "close",
      );
      return s.closed && s.phase === "absent" && s;
    } catch {
      return false;
    }
  }, "allocation closure");
}
try {
  const a = input();
  loseNextReply = true;
  const first = await client.create(a);
  assert.equal(loseNextReply, false, "The successful create reply was not dropped");
  assert.equal(forwardedCreates, 1);
  const duplicate = await client.create(a);
  assert.equal(duplicate.sandboxId, first.sandboxId);
  assert.equal(duplicate.nodeId, first.nodeId);
  assert.equal(duplicate.trafficAccessToken, first.trafficAccessToken);
  const state = await client.allocation(a.allocation.id, a.allocation.createBefore, "get");
  assert.equal(state.instance.sandboxId, first.sandboxId);
  assert.equal(
    (await client.list()).filter((v) => v.metadata["picloud.allocation_id"] === a.allocation.id)
      .length,
    1,
  );
  const result = await client.runCommand(first, {
    command: "printf ALLOCATION_RECOVERY_OK",
    cwd: "/workspace",
    user: "root",
    timeoutMs: 5000,
    maximumOutputBytes: 1024,
  });
  assert.equal(result.stdout, "ALLOCATION_RECOVERY_OK");
  await closed(a);
  await assert.rejects(client.create(a));
  assert.equal((await client.observe(first.sandboxId, first.nodeId)).presence, "absent");
  report.cases.push({
    name: "lost_reply_and_duplicate",
    sameVm: true,
    guestUsable: true,
    lateCreateRejected: true,
    nodeAbsenceConfirmed: true,
  });

  const b = input();
  await closed(b);
  await assert.rejects(client.create(b));
  assert.equal(
    (await client.list()).some((v) => v.metadata["picloud.allocation_id"] === b.allocation.id),
    false,
  );
  report.cases.push({ name: "close_before_create", lateCreateRejected: true });

  const c = input();
  const creating = client.create(c).then(
    (value) => ({ value }),
    (error) => ({ error }),
  );
  const during = await until(async () => {
    const state = await client.allocation(c.allocation.id, c.allocation.createBefore, "get");
    return state.nodeId && state;
  }, "node placement");
  assert.equal(during.phase, "creating", "Native creation race was not reached");
  const end = await closed(c);
  await creating;
  assert.equal((await client.observe(end.sandboxId, end.nodeId)).presence, "absent");
  await assert.rejects(client.create(c));
  report.cases.push({
    name: "close_during_creation",
    observedPhase: during.phase,
    nodeAbsenceConfirmed: true,
    lateCreateRejected: true,
  });
  report.accepted = true;
} catch (error) {
  failure = error;
} finally {
  const cleanup = [];
  for (const value of inputs) {
    try {
      await closed(value);
    } catch (error) {
      cleanup.push(error);
    }
  }
  await client.close();
  await new Promise((ok) => proxy.close(ok));
  report.cleanupCompleted = cleanup.length === 0;
  if (failure) report.failure = failure.message;
  await writeFile(
    process.argv[2] ?? "/tmp/pi-cloud-vm-allocation-live.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
  if (failure || cleanup.length)
    throw new AggregateError(
      [failure, ...cleanup].filter(Boolean),
      "VM allocation acceptance failed",
    );
}
