import { registeredBackend } from "./lib/registered-backend-fixture.mjs";
import { withChromePage } from "./lib/chrome-cdp.mjs";
import { armRuntimeRestore } from "./lib/owned-runtime-outage.mjs";
import { nativeCubeLifecycleOptions } from "./lib/cube-native-lifecycle-options.mjs";
/** Owned stock-SDK/Volume check. Verifies real host/Guest UID identity,
 * pause/resume, API replacement and positive physical cleanup. */
import assert from "node:assert/strict";
import { readFile, writeFile, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { PiCloudApi } from "../packages/web-ui/src/api.ts";
import { HttpWorkspaceVolumeGateway } from "../packages/sandbox-control/src/workspace-volume-gateway.ts";
import { BoxLiteRuntimeClient } from "../packages/sandbox-control/src/boxlite-runtime-client.ts";
import { OfficialCubeSandboxRuntimeClient } from "../packages/sandbox-control/src/cubesandbox-runtime-client.ts";
import { WorkspaceQuotaClient } from "../packages/sandbox-control/src/workspace-quota-client.ts";
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
const cfg = JSON.parse(await readFile(runtimeDirectory + "/k3s/boxlite.json", "utf8"));
const storage = new HttpWorkspaceVolumeGateway({
  baseUrl: `http://${serviceAddress("workspace-volume-gateway")}:4500`,
  serviceToken: await secret("workspace-volume-gateway-token"),
});
const host = JSON.parse(kubectl(["get", "service", "pi-cloud-boxlite", "-o", "json"])).spec
  .clusterIP;
const box = new BoxLiteRuntimeClient({
  url: `http://${host}:8091`,
  nodeId: cfg.nodeId,
  token: await secret("sandbox-control-token"),
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
let tenant, api, project, instance, failure, cube, cubeInstance, outage, session, active;
async function until(read, label, ms = 180000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(500);
  }
  throw Error("Timed out: " + label);
}
async function restoreCube() {
  if (!outage) return;
  await outage.restore();
  kubectl(["rollout", "status", "deployment/cube-api", "--timeout=180s"], { timeout: 185000 });
  outage = undefined;
}
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
  const backend = await registeredBackend(api, "boxlite");
  report.tenantId = tenant.tenantId;
  report.tenantSlug = tenant.tenantSlug;
  await save();
  outage = await armRuntimeRestore("cube-api", path + ".cube-restore.json", Date.now() + 1800000);
  kubectl(["scale", "deployment/cube-api", "--replicas=0"]);
  kubectl(["wait", "--for=delete", "pod", "-l", outage.selector, "--timeout=180s"], {
    timeout: 185000,
  });
  const projectName = "Box browser Workspace " + randomUUID().slice(0, 8);
  await withChromePage({}, async (page) => {
    await page.send("Network.setExtraHTTPHeaders", {
      headers: { Authorization: "Bearer " + tenant.credential.token },
    });
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: "localStorage.setItem('pi-cloud:ui-language','zh-CN')",
    });
    await page.navigate(base);
    await page.waitFor(
      "[...document.querySelectorAll('button')].some(b=>b.textContent.includes('资源管理'))",
    );
    await page.evaluate(
      "[...document.querySelectorAll('button')].find(b=>b.textContent.includes('资源管理')).click()",
    );
    await page.waitFor("document.querySelector('.product-resource-tabs')");
    await page.evaluate("document.querySelector('.product-resource-tabs button').click()");
    await page.waitFor(
      `[...document.querySelectorAll('select[aria-label=集群] option')].some(o=>o.value===${JSON.stringify(backend.id)})`,
    );
    await page.evaluate(
      `(() => { const form=document.querySelector('.product-resource-create');const select=form.querySelector('select[aria-label=集群]');select.value=${JSON.stringify(backend.id)};select.dispatchEvent(new Event('change',{bubbles:true}));const input=form.querySelector('input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(projectName)});input.dispatchEvent(new Event('input',{bubbles:true})); })()`,
    );
    await page.waitFor(
      "!document.querySelector('.product-resource-create button[type=submit]').disabled",
    );
    await page.evaluate(
      "document.querySelector('.product-resource-create button[type=submit]').click()",
    );
    project = await until(async () => {
      const row = await db
        .selectFrom("workspaces")
        .select(["id", "project_id", "sandbox_domain_id", "backend_template_id"])
        .where("tenant_id", "=", tenant.tenantId)
        .executeTakeFirst();
      if (!row) return false;
      assert.equal(row.sandbox_domain_id, backend.id);
      assert.equal(row.backend_template_id, backend.templateId);
      return { projectId: row.project_id, workspaceId: row.id };
    }, "Browser-selected BoxLite Workspace");
  });
  report.checks.push("resource-page-creates-selected-backend-without-cube");
  report.workspaceId = project.workspaceId;
  await save();
  const volumeId = workspaceVolumeId({
    tenantId: tenant.tenantId,
    workspaceId: project.workspaceId,
  });
  const reference = await storage.persistence.ensure({
    tenantId: tenant.tenantId,
    workspaceId: project.workspaceId,
    sessionId: randomUUID(),
    volumeId,
  });
  const grown = await api.growWorkspaceCapacity(project.workspaceId, 40);
  assert.equal(grown.capacityBytes, 40 * 1024 ** 3);
  await until(
    async () => !(await api.workspaceCapacity(project.workspaceId)).pending,
    "Live quota growth",
  );
  const quota = new WorkspaceQuotaClient(
    `http://${serviceAddress("workspace-quota")}:4510`,
    await secret("workspace-volume-gateway-token"),
  );
  const actualQuota = await quota.read({
    tenantId: tenant.tenantId,
    workspaceId: project.workspaceId,
    volumeId,
    generation: reference.generation,
  });
  assert.equal(actualQuota.state, "ready");
  assert.equal(actualQuota.capacityBytes, grown.capacityBytes);
  assert.equal(JSON.parse(kubectl(["get", "deployment/cube-api", "-o", "json"])).spec.replicas, 0);
  report.checks.push("kernel-capacity-growth-without-cube");
  await restoreCube();
  const cluster = JSON.parse(
    await readFile(runtimeDirectory + "/cubesandbox/cluster.json", "utf8"),
  );
  const template = JSON.parse(
    await readFile(runtimeDirectory + "/cubesandbox/template.json", "utf8"),
  );
  cube = new OfficialCubeSandboxRuntimeClient({
    ...nativeCubeLifecycleOptions(),
    apiUrl: `http://${cluster.api.host}:${cluster.api.port}`,
    apiKey: await secret("cubesandbox-api-key"),
    proxyNodeIp: cluster.proxy.host,
    proxyPort: cluster.proxy.port,
    proxyScheme: "http",
    sandboxDomain: cluster.sandboxDomain,
    egressProxyIp: "10.255.255.254",
  });
  await cube.ensureVolume(volumeId, "picloud-posix");
  report.cubeRequest = {
    templateId: template.agent.templateId,
    timeoutSeconds: 900,
    metadata: {
      "picloud.managed": "true",
      "picloud.workspace_runtime_id": randomUUID(),
      "picloud.tenant_id": tenant.tenantId,
      "picloud.workspace_id": project.workspaceId,
    },
    volumeMounts: [{ name: volumeId, path: "/home/user" }],
  };
  await save();
  cubeInstance = await cube.create(report.cubeRequest);
  report.cubeInstance = cubeInstance;
  await save();
  await until(async () => {
    try {
      return (
        (
          await cube.runCommand(cubeInstance, {
            command: "true",
            cwd: "/home/user",
            user: "user",
            timeoutMs: 5000,
            maximumOutputBytes: 1024,
          })
        ).exitCode === 0
      );
    } catch {
      return false;
    }
  }, "Cube data channel ready");
  const written = await cube.runCommand(cubeInstance, {
    command:
      "printf CUBE_RETAINED > /home/user/cube-switch-marker && cat /home/user/cube-switch-marker",
    cwd: "/home/user",
    user: "user",
    timeoutMs: 10000,
    maximumOutputBytes: 1024,
  });
  assert.equal(written.exitCode, 0);
  assert.equal(written.stdout, "CUBE_RETAINED");
  const originalFile =
    runtimeDirectory +
    "/state/cube-shared/volume/picloud-posix-" +
    volumeId +
    "/workspace/cube-switch-marker";
  const originalStat = await stat(originalFile);
  await cube.destroy(cubeInstance.sandboxId);
  await until(
    async () =>
      (await cube.observe(cubeInstance.sandboxId, cubeInstance.nodeId)).presence === "absent",
    "Positive Cube retirement",
  );
  cubeInstance = undefined;
  report.cubeRetired = true;
  await cube.deleteVolume(volumeId);
  await until(async () => !(await cube.hasVolume(volumeId)), "Native registration retirement");
  assert.equal(await readFile(originalFile, "utf8"), "CUBE_RETAINED");
  const activationId = randomUUID();
  const request = {
    templateId: "tool",
    metadata: {
      "picloud.workspace_runtime_id": activationId,
      "picloud.managed": "true",
      "picloud.tenant_id": tenant.tenantId,
      "picloud.workspace_id": project.workspaceId,
    },
    volumeMounts: [{ name: volumeId, path: "/home/user", storage: reference }],
  };
  report.request = request;
  await save();
  instance = await box.create(request);
  report.instance = instance;
  await save();
  console.log("Owned Box VM created");
  const first = await command(
    "test \"$(cat /home/user/cube-switch-marker)\" = CUBE_RETAINED && id -u && printf 'WORKSPACE_RETAINED' > /home/user/box-node-marker && cat /home/user/box-node-marker",
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
  const transferred = await stat(originalFile);
  assert.deepEqual(
    [transferred.dev, transferred.ino, transferred.uid, transferred.gid],
    [originalStat.dev, originalStat.ino, 1000, 1000],
  );
  report.checks.push("cube-to-boxlite-same-workspace-inode-no-copy");
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
  await box.destroy(instance.sandboxId, instance);
  assert.equal(
    (await box.observe(instance.sandboxId, instance.nodeId, instance)).presence,
    "absent",
  );
  instance = undefined;
  report.boxRetired = true;
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Browser-selected Box Tool",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "low", fastMode: false },
  );
  report.sessionId = session.sessionId;
  await save();
  const verifyCommand =
    'test "$(cat /workspace/cube-switch-marker)" = CUBE_RETAINED && test "$(cat /workspace/box-node-marker)" = WORKSPACE_RETAINED && printf CROSS_PROVIDER_TOOL_OK';
  active = await api.acceptTurn(
    session.sessionId,
    "Call bash exactly once with command " +
      JSON.stringify(verifyCommand) +
      ". Do not call any other Tool or change the command. Then reply briefly.",
    randomUUID(),
    "low",
  );
  report.runId = active.runId;
  await save();
  const result = await until(
    async () => {
      const r = await api.getRun(active.runId);
      return ["completed", "failed", "cancelled", "timed_out"].includes(r.state) && r;
    },
    "Managed Box Tool",
    600000,
  );
  assert.equal(result.state, "completed");
  const tools = (await api.getConversation(session.sessionId)).turns
    .find((t) => t.runId === active.runId)
    .transcript.items.filter((i) => i.kind === "tool");
  assert.equal(tools.length, 1);
  assert.equal(tools[0].toolName, "bash");
  assert.equal(tools[0].status, "completed");
  assert.equal(tools[0].input.command, verifyCommand);
  assert(JSON.stringify(tools[0].output).includes("CROSS_PROVIDER_TOOL_OK"));
  report.checks.push("browser-created-workspace-completes-real-box-tool");
} catch (e) {
  failure = e;
  report.error = { name: e.name, message: e.message };
  await save();
}
try {
  await restoreCube();
  if (active && session) {
    const state = await api.getRun(active.runId);
    if (!["completed", "failed", "cancelled", "timed_out"].includes(state.state)) {
      await api.cancelTurn(session.sessionId, active.turnId, randomUUID());
      await until(
        async () =>
          ["completed", "failed", "cancelled", "timed_out"].includes(
            (await api.getRun(active.runId)).state,
          ),
        "Cancel owned Run",
      );
    }
  }
  if (session) await api.deleteConversation(session.sessionId);
  if (instance) {
    await box.destroy(instance.sandboxId, instance);
    assert.equal(
      (await box.observe(instance.sandboxId, instance.nodeId, instance)).presence,
      "absent",
    );
    report.checks.push("physical-delete-confirmed");
  } else if (report.request && !report.boxRetired) {
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
  if (cubeInstance) {
    await cube.destroy(cubeInstance.sandboxId);
    await until(
      async () =>
        (await cube.observe(cubeInstance.sandboxId, cubeInstance.nodeId)).presence === "absent",
      "Cube cleanup",
    );
    report.cubeRetired = true;
  } else if (report.cubeRequest && !report.cubeRetired)
    throw Error("Cube create unconfirmed; keep its Workspace and receipt");
  if (cube && project)
    await cube.deleteVolume(
      workspaceVolumeId({ tenantId: tenant.tenantId, workspaceId: project.workspaceId }),
    );
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
await cube?.close();
await storage.close();
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
