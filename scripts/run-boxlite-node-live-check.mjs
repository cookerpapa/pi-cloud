/** Owned stock-SDK/Volume check. Verifies real host/Guest UID identity,
 * pause/resume, API replacement and positive physical cleanup. */
import assert from "node:assert/strict";
import { readFile, writeFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { PiCloudApi } from "../packages/web-ui/src/api.ts";
import { OfficialCubeSandboxRuntimeClient } from "../packages/sandbox-control/src/cubesandbox-runtime-client.ts";
import { BoxLiteRuntimeClient } from "../packages/sandbox-control/src/boxlite-runtime-client.ts";
import { workspaceVolumeId } from "../packages/sandbox-control/src/workspace-volume-gateway-contract.ts";
import {
  runtimeDirectory,
  serviceAddress,
  kubectl,
  runtimeEnvironment,
} from "./lib/production-kubernetes.mjs";
import { purgeOwnedAcceptanceTenant } from "./lib/owned-acceptance-cleanup.mjs";
const secret = async (n) => (await readFile(runtimeDirectory + "/secrets/" + n, "utf8")).trim();
const pg = new URL(await secret("database-url"));
pg.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: pg.toString(), maxConnections: 1 });
const cluster = JSON.parse(await readFile(runtimeDirectory + "/cubesandbox/cluster.json", "utf8"));
const cfg = JSON.parse(await readFile(runtimeDirectory + "/k3s/boxlite.json", "utf8"));
const cube = new OfficialCubeSandboxRuntimeClient({
  apiUrl: `http://${cluster.api.host}:${cluster.api.port}`,
  apiKey: await secret("cubesandbox-api-key"),
  proxyNodeIp: cluster.proxy.host,
  proxyPort: cluster.proxy.port,
  proxyScheme: "http",
  sandboxDomain: cluster.sandboxDomain,
  egressProxyIp: "10.255.255.254",
});
const host = JSON.parse(kubectl(["get", "service", "pi-cloud-boxlite", "-o", "json"])).spec
  .clusterIP;
const box = new BoxLiteRuntimeClient({
  url: `http://${host}:8091`,
  nodeId: cfg.nodeId,
  token: await secret("sandbox-control-token"),
  volumes: cube,
});
assert.equal(
  process.env.PI_CLOUD_LIVE_BOXLITE_CHECK,
  "1",
  "Opt in to owned BoxLite VM and Workspace checks",
);
assert(process.argv[2], "Supply a private report path");
const path = process.argv[2];
const report = { startedAt: new Date().toISOString(), checks: [], cleanupConfirmed: false };
const save = () => writeFile(path, JSON.stringify(report, null, 2), { mode: 0o600 });
let tenant, api, project, instance, failure;
const command = (c) =>
  box.runCommand(instance, {
    command: c,
    cwd: "/home/user",
    user: "1000:1000",
    timeoutMs: 10000,
    maximumOutputBytes: 16384,
  });
try {
  await box.checkHealth();
  tenant = await createPrivateTenant(db, {
    slug: "release-acceptance-box-node-" + Date.now(),
    ownerDisplayName: "Owned Box node acceptance",
  });
  const base = "http://127.0.0.1:" + runtimeEnvironment().PI_CLOUD_HTTP_PORT;
  api = new PiCloudApi((path, init) => fetch(new URL(path, base), init), tenant.credential.token);
  report.tenantId = tenant.tenantId;
  report.tenantSlug = tenant.tenantSlug;
  await save();
  project = await api.createProject("Owned Box node acceptance", { kind: "empty" });
  report.workspaceId = project.workspaceId;
  await save();
  const volumeId = workspaceVolumeId({
    tenantId: tenant.tenantId,
    workspaceId: project.workspaceId,
  });
  await cube.ensureVolume(volumeId, "picloud-posix");
  const activationId = randomUUID();
  const request = {
    templateId: "tool",
    metadata: {
      "picloud.workspace_runtime_id": activationId,
      "picloud.managed": "true",
      "picloud.tenant_id": tenant.tenantId,
      "picloud.workspace_id": project.workspaceId,
    },
    volumeMounts: [{ name: volumeId, path: "/home/user" }],
  };
  report.request = request;
  await save();
  instance = await box.create(request);
  report.instance = instance;
  await save();
  console.log("Owned Box VM created");
  const first = await command(
    "id -u; printf 'WORKSPACE_RETAINED' > /home/user/box-node-marker; cat /home/user/box-node-marker",
  );
  assert.equal(first.exitCode, 0);
  assert.match(first.stdout, /^1000\nWORKSPACE_RETAINED/);
  const hostPath = instance.attachment.hostPath.replace(
    "/data/cube-shared/volume",
    runtimeDirectory + "/state/cube-shared/volume",
  );
  for (const path of [hostPath, hostPath + "/box-node-marker"]) {
    const s = await stat(path);
    assert.equal(s.uid, 1000);
    assert.equal(s.gid, 1000);
  }
  report.checks.push("host-and-guest-uid1000-aligned");
  report.checks.push("native-exec-and-workspace");
  await save();
  // Dedicated initialization removes the unused elastic directory. The native
  // init process must not inherit that removable image WORKDIR on its next boot.
  const removed = await box.runCommand(instance, {
    command: "rmdir /workspace; test ! -e /workspace",
    cwd: "/",
    user: "0:0",
    timeoutMs: 10000,
    maximumOutputBytes: 8192,
  });
  assert.equal(removed.exitCode, 0);
  await box.pause(instance.sandboxId);
  assert.equal((await box.read(instance.sandboxId)).state, "paused");
  await assert.rejects(() => command("true"));
  report.checks.push("paused-exec-does-not-autostart");
  instance = await box.connect(instance.sandboxId);
  report.instance = instance;
  await save();
  assert.equal((await command("cat /home/user/box-node-marker")).stdout, "WORKSPACE_RETAINED");
  report.checks.push("explicit-resume-retains-workspace");
  await save();
  const before = instance.connection;
  assert.equal(
    (
      await db
        .selectFrom("runs")
        .select("id")
        .where("state", "not in", ["completed", "failed", "cancelled", "timed_out"])
        .execute()
    ).length,
    0,
  );
  kubectl([
    "exec",
    "pi-cloud-boxlite-0",
    "-c",
    "node",
    "--",
    "/usr/bin/supervisorctl",
    "-c",
    "/etc/pi-cloud/boxlite-supervisord.conf",
    "restart",
    "api",
  ]);
  const end = Date.now() + 60000;
  for (;;) {
    try {
      await box.checkHealth();
      break;
    } catch (e) {
      if (Date.now() > end) throw e;
      await delay(500);
    }
  }
  instance = await box.read(instance.sandboxId);
  assert(instance);
  assert.equal(instance.state, "running");
  assert.equal(instance.connection.processes[0].startTime, before.processes[0].startTime);
  assert.equal((await command("cat /home/user/box-node-marker")).stdout, "WORKSPACE_RETAINED");
  report.checks.push("api-restart-retains-vm");
  await save();
} catch (e) {
  failure = e;
  report.error = { name: e.name, message: e.message };
  await save();
}
try {
  if (instance) {
    await box.destroy(instance.sandboxId, instance);
    assert.equal(
      (await box.observe(instance.sandboxId, instance.nodeId, instance)).presence,
      "absent",
    );
    report.checks.push("physical-delete-confirmed");
  } else if (report.request) {
    const found = (await box.list()).find(
      (x) =>
        x.metadata["picloud.workspace_runtime_id"] ===
        report.request.metadata["picloud.workspace_runtime_id"],
    );
    if (found) {
      report.instance = found;
      await save();
      await box.destroy(found.sandboxId, found);
    } else throw Error("Creation unconfirmed; retain Workspace and private receipt");
  }
  if (project) {
    await api.deleteWorkspace(project.workspaceId, randomUUID());
    const end = Date.now() + 180000;
    for (;;) {
      const w = await db
        .selectFrom("workspaces")
        .select("storage_purged_at")
        .where("id", "=", project.workspaceId)
        .executeTakeFirst();
      if (!w || w.storage_purged_at) break;
      if (Date.now() > end) throw Error("Workspace cleanup unconfirmed");
      await delay(500);
    }
  }
  if (tenant)
    await purgeOwnedAcceptanceTenant(db, tenant, {
      delete: async () => {
        throw Error("Unexpected blob");
      },
    });
  report.cleanupConfirmed = true;
} catch (e) {
  report.cleanupError = { name: e.name, message: e.message };
  failure ??= e;
}
await save();
await box.close();
await db.destroy();
console.log(
  JSON.stringify({
    checks: report.checks,
    cleanupConfirmed: report.cleanupConfirmed,
    error: report.error,
    cleanupError: report.cleanupError,
  }),
);
if (failure) process.exitCode = 1;
