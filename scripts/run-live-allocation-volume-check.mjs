// Owns every VM/Volume it creates. No user resource or Run is modified.
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFile, writeFile, rm, lstat, realpath, open } from "node:fs/promises";
import { resolve, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { OfficialCubeSandboxRuntimeClient } from "../packages/sandbox-control/src/cubesandbox-runtime-client.ts";

if (process.env.PI_CLOUD_LIVE_ALLOCATION_VOLUME_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_ALLOCATION_VOLUME_CHECK=1 for disposable native Cube/Volume acceptance",
  );
const base = resolve(process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime");
const cluster = JSON.parse(await readFile(join(base, "cubesandbox/cluster.json"), "utf8"));
const template = JSON.parse(await readFile(join(base, "cubesandbox/template.json"), "utf8"));
const apiUrl = `http://${cluster.api.host}:${cluster.api.port}`;
const key = (await readFile(join(base, "secrets/cubesandbox-api-key"), "utf8")).trim();
const client = new OfficialCubeSandboxRuntimeClient({
  apiUrl,
  apiKey: key,
  proxyNodeIp: cluster.proxy.host,
  proxyPort: cluster.proxy.port,
  proxyScheme: "http",
  sandboxDomain: cluster.sandboxDomain,
  egressProxyIp: "10.255.255.254",
  requestTimeoutMs: 90_000,
});
const volumeId = `pcw-${randomBytes(24).toString("hex")}`;
const allocations = [];
const report = {
  checkedAt: new Date().toISOString(),
  accepted: false,
  volumeId,
  allocations: [],
  checks: {},
  cleanupConfirmed: false,
};
let volumeCreated = false,
  failure;
async function volume() {
  const response = await fetch(`${apiUrl}/volumes/${volumeId}`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(5000),
  });
  if (response.status === 404) {
    await response.body?.cancel();
    return undefined;
  }
  assert(response.ok, `Volume query HTTP ${response.status}`);
  return response.json();
}
function spec() {
  const allocation = { id: randomUUID(), createBefore: Date.now() + 300_000 };
  const item = { allocation, closed: false };
  allocations.push(item);
  return {
    item,
    input: {
      allocation,
      templateId: template.development.starter.templateId,
      timeoutSeconds: 600,
      metadata: { "picloud.managed": "true", "picloud.workload": "allocation-volume-acceptance" },
      allowInternetAccess: true,
      allowPublicTraffic: false,
      volumeMounts: [{ name: volumeId, path: "/home/user" }],
    },
  };
}
async function close(item) {
  const result = await client.allocation(item.allocation.id, item.allocation.createBefore, "close");
  assert(result.closed && result.phase === "absent", "VM closure remains unconfirmed");
  if (item.instance)
    assert.equal(
      (await client.observe(item.instance.sandboxId, item.instance.nodeId)).presence,
      "absent",
    );
  item.closed = true;
}
async function command(instance, text) {
  const result = await client.runCommand(instance, {
    command: text,
    cwd: "/home/user",
    user: "user",
    timeoutMs: 10000,
    maximumOutputBytes: 8192,
  });
  assert.equal(result.exitCode, 0, result.stderr);
  return result.stdout.trim();
}
async function authorizeOwnedVolumeDeletion() {
  const parent = await realpath(join(base, "state/cube-shared/volume"));
  const root = join(parent, `picloud-posix-${volumeId}`);
  assert.equal(await realpath(root), root);
  const meta = join(root, ".pi-cloud-runtime"),
    identity = join(meta, "identity");
  assert(!(await lstat(meta)).isSymbolicLink() && !(await lstat(identity)).isSymbolicLink());
  const fields = (await readFile(identity, "utf8")).trim().split("\n");
  assert.equal(fields[0], "pi-cloud-volume-v1");
  assert.equal(fields[1], volumeId);
  assert.match(fields[2], /^[0-9a-f]{64}$/);
  // Same trusted-generation marker as normal Workspace GC, scoped to this
  // script's newly created Volume. Never write a marker for an existing Volume.
  const marker = await open(join(meta, "delete-authorized"), "wx", 0o400);
  try {
    await marker.writeFile(`pi-cloud-volume-delete-v1\n${volumeId}\n${fields[2]}\n`);
    await marker.sync();
  } finally {
    await marker.close();
  }
  return root;
}
try {
  assert.equal(await volume(), undefined);
  await client.ensureVolume(volumeId, "picloud-posix");
  volumeCreated = true;
  const first = spec(),
    second = spec();
  first.item.instance = await client.create(first.input);
  second.item.instance = await client.create(second.input);
  const proof = randomUUID();
  await command(first.item.instance, `printf '%s' '${proof}' > shared-proof.txt`);
  assert.equal(await command(second.item.instance, "cat shared-proof.txt"), proof);
  report.checks.sharedBytes = true;
  await client.executionTarget(first.item.instance.sandboxId, first.item.instance.nodeId);
  await client.pause(first.item.instance.sandboxId);
  assert.equal((await client.read(first.item.instance.sandboxId))?.state, "paused");
  await close(first.item);
  report.checks.pausedDirectClose = true;
  assert.equal(await command(second.item.instance, "cat shared-proof.txt"), proof);
  await assert.rejects(client.deleteVolume(volumeId), (error) => error.statusCode === 409);
  assert.equal(await command(second.item.instance, "cat shared-proof.txt"), proof);
  report.checks.sharedReferencePreventsDelete = true;
  const late = spec();
  await assert.rejects(client.create(late.input));
  await close(late.item);
  report.checks.deletingVolumeRejectsNewPlacement = true;
  await close(second.item);
  await assert.rejects(client.create(first.input));
  report.checks.closedAllocationRejectsDelayedCreate = true;
  report.accepted = true;
} catch (error) {
  failure = error;
} finally {
  const cleanupErrors = [];
  for (const item of allocations) {
    for (let i = 0; i < 5 && !item.closed; i++) {
      try {
        await close(item);
      } catch (error) {
        if (i === 4) cleanupErrors.push(error);
        else await delay(1000);
      }
    }
    report.allocations.push({
      allocationId: item.allocation.id,
      sandboxId: item.instance?.sandboxId,
      nodeId: item.instance?.nodeId,
      closed: item.closed,
    });
  }
  if (volumeCreated && allocations.every((a) => a.closed)) {
    try {
      const root = await authorizeOwnedVolumeDeletion();
      await client.deleteVolume(volumeId);
      assert.equal(await volume(), undefined);
      // Physical absence and closed admission for every fixture VM are proven.
      // Remove only the disposable plugin envelope, never another Workspace.
      await rm(root, { recursive: true });
      report.checks.volumeDeletedAfterFinalReference = true;
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  await client.close();
  report.cleanupConfirmed =
    cleanupErrors.length === 0 &&
    (!volumeCreated || report.checks.volumeDeletedAfterFinalReference === true);
  if (failure) report.failure = failure.message;
  if (cleanupErrors.length) report.cleanupErrors = cleanupErrors.map((e) => e.message);
  await writeFile(
    process.argv[2] ?? "docs/reports/allocation-volume-acceptance-20261005.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
  if (failure || !report.cleanupConfirmed)
    throw failure ?? new AggregateError(cleanupErrors, "Owned native cleanup unconfirmed");
}
