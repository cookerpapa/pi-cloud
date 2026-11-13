import { registeredBackend } from "./lib/registered-backend-fixture.mjs";
import { armRuntimeRestore } from "./lib/owned-runtime-outage.mjs";
/** Product/API lifecycle checks for the explicit BoxLite backend.
 * Advances only one owned, retired Session's idle deadline as a clock fixture.
 * It does not claim to measure an actual 30-minute wall-clock interval. */
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import WebSocket from "ws";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { PiCloudApi } from "../packages/web-ui/src/api.ts";
import { newIdempotencyKey } from "@pi-cloud/session-client";
import { BoxLiteRuntimeClient } from "../packages/sandbox-control/src/boxlite-runtime-client.ts";
import { S3AttachmentBlobStore } from "../packages/session-attachments/src/s3.ts";
import {
  runtimeDirectory,
  runtimeEnvironment,
  serviceAddress,
  kubectl,
} from "./lib/production-kubernetes.mjs";
import { purgeOwnedAcceptanceTenant } from "./lib/owned-acceptance-cleanup.mjs";
import { readPreviewDocument } from "./lib/preview-client.mjs";
assert.equal(process.env.PI_CLOUD_LIVE_BOXLITE_CHECK, "1");
const output = resolve(process.argv[2]);
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
const secret = async (name) =>
  (await readFile(runtimeDirectory + "/secrets/" + name, "utf8")).trim();
const pg = new URL(await secret("database-url"));
pg.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: pg.toString(), maxConnections: 2 });
const cfg = JSON.parse(await readFile(runtimeDirectory + "/k3s/boxlite.json", "utf8"));
const host = JSON.parse(kubectl(["get", "service", "pi-cloud-boxlite", "-o", "json"])).spec
  .clusterIP;
const client = new BoxLiteRuntimeClient({
  url: `http://${host}:8091`,
  nodeId: cfg.nodeId,
  token: await secret("sandbox-control-token"),
});
const base = "http://127.0.0.1:" + runtimeEnvironment().PI_CLOUD_HTTP_PORT;
const report = {
  startedAt: new Date().toISOString(),
  provider: "boxlite",
  model: "gpt-6-luna",
  accepted: false,
  cleanupConfirmed: false,
  checks: [],
  clock: "only the owned expiry fixture deadline is advanced; production policy is unchanged",
};
const save = () => writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
async function until(fn, label, ms = 180000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await delay(500);
  }
  throw Error("Timed out: " + label);
}
let tenant, api, machine, project, session, active, instance, failure, cubeOutage;
const isTerminal = (r) => ["completed", "failed", "cancelled", "timed_out"].includes(r.state);
const machineState = async (state) =>
  until(async () => {
    if (state === "released") {
      // Released machines disappear from the product list. Cleanup is confirmed
      // by the existing resource owner's physical-absence record, not omission.
      const row = await db
        .selectFrom("development_environments")
        .select(["state", "allocation_closed", "allocation_absent"])
        .where("id", "=", machine.environmentId)
        .executeTakeFirstOrThrow();
      return row.state === "released" && row.allocation_closed && row.allocation_absent;
    }
    const r = (await api.listDevelopmentEnvironments()).environments.find(
      (m) => m.environmentId === machine.environmentId,
    );
    if (r?.state === "failed" && state !== "released")
      throw Error("Machine failed: " + r.failureCode);
    return r?.state === state ? r : false;
  }, "machine " + state);
async function terminal(command) {
  const socket = new WebSocket(
    base.replace("http", "ws") + `/v1/development-environments/${machine.environmentId}/terminal`,
    { headers: { authorization: "Bearer " + tenant.credential.token } },
  );
  const marker = "BOX_OK_" + randomUUID().replaceAll("-", "");
  const script = Buffer.from(`set -e\n${command}\nprintf '\\n${marker}\\n'\n`).toString("base64");
  return new Promise((resolve, reject) => {
    let text = "",
      done = false;
    const timer = setTimeout(() => {
      socket.terminate();
      reject(Error("Terminal did not complete"));
    }, 60000);
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("unexpected-response", (_request, response) => {
      let diagnostic = "";
      response.on("data", (chunk) => {
        diagnostic = (diagnostic + chunk.toString()).slice(0, 4096);
      });
      response.on("end", () => {
        clearTimeout(timer);
        reject(new Error(`Terminal handshake ${response.statusCode}: ${diagnostic}`));
        socket.terminate();
      });
    });
    socket.on("message", (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.type === "workspace_terminal.ready")
        socket.send(
          JSON.stringify({
            workspaceTerminalProtocolVersion: 2,
            type: "workspace_terminal.input",
            data: Buffer.from(`printf '%s' '${script}' | base64 -d | bash\n`).toString("base64"),
          }),
        );
      if (f.type === "workspace_terminal.output") {
        text += Buffer.from(f.data, "base64").toString();
        if (text.includes(marker)) {
          done = true;
          socket.send(
            JSON.stringify({
              workspaceTerminalProtocolVersion: 2,
              type: "workspace_terminal.close",
            }),
          );
        }
      }
      if (f.type === "workspace_terminal.error") {
        clearTimeout(timer);
        socket.terminate();
        reject(Error("Terminal error: " + f.code));
      }
    });
    socket.on("close", () => {
      clearTimeout(timer);
      done ? resolve(text) : reject(Error("Terminal ended without success"));
    });
  });
}
async function run(command, marker) {
  active = await api.acceptTurn(
    session.sessionId,
    `只调用一次 bash，command 精确使用以下 JSON 字符串：${JSON.stringify(command)}。不要搜索、委派或其他工具。完成后简短回复。`,
    newIdempotencyKey("box-lifecycle"),
    "low",
  );
  report.runIds ??= [];
  report.runIds.push(active.runId);
  await save();
  const settled = await until(
    async () => {
      const r = await api.getRun(active.runId);
      return isTerminal(r) ? r : false;
    },
    "model run",
    600000,
  );
  assert.equal(settled.state, "completed", JSON.stringify(settled.failure));
  const turn = (await api.getConversation(session.sessionId)).turns.find(
    (t) => t.runId === active.runId,
  );
  const tools = turn?.transcript?.items.filter((item) => item.kind === "tool") ?? [];
  assert.equal(tools.length, 1, "Expected exactly one requested Bash operation");
  assert.equal(tools[0].toolName, "bash");
  assert.equal(tools[0].status, "completed", "Bash failed despite a completed outer Run");
  assert.equal(tools[0].input.command, command, "Model changed the verification command");
  assert(
    JSON.stringify(tools[0].output).includes(marker),
    "Tool did not confirm the expected file content",
  );
  await until(
    async () =>
      !(
        await db
          .selectFrom("session_leases")
          .select("lease_id")
          .where("tenant_id", "=", tenant.tenantId)
          .where("released_at", "is", null)
          .execute()
      ).length,
    "writer retirement",
  );
}
try {
  await client.checkHealth();
  if (process.env.PI_CLOUD_LIVE_CUBE_UNAVAILABLE === "1") {
    cubeOutage = await armRuntimeRestore(
      "cube-api",
      output + ".cube-restore.json",
      Date.now() + 1_800_000,
    );
    kubectl([
      "scale",
      "deployment/cube-api",
      "--current-replicas=" + cubeOutage.receipt.replicas,
      "--replicas=0",
    ]);
    kubectl(["wait", "--for=delete", "pod", "-l", cubeOutage.selector, "--timeout=180s"], {
      timeout: 185_000,
    });
    report.cubeUnavailable = {
      startedAt: new Date().toISOString(),
      deploymentUid: cubeOutage.receipt.uid,
    };
    await save();
  }
  tenant = await createPrivateTenant(db, {
    slug: "release-acceptance-box-lifecycle-" + Date.now(),
    ownerDisplayName: "Owned BoxLite lifecycle",
    initialModel: { provider: "openai-codex", modelId: "gpt-6-luna" },
  });
  report.tenantId = tenant.tenantId;
  report.tenantSlug = tenant.tenantSlug;
  await save();
  api = new PiCloudApi((path, init) => fetch(new URL(path, base), init), tenant.credential.token);
  const backend = await registeredBackend(api, "boxlite");
  machine = await api.createDevelopmentEnvironment(
    "BoxLite lifecycle",
    "starter",
    newIdempotencyKey("box-machine"),
    undefined,
    backend,
  );
  report.machineId = machine.environmentId;
  report.machineWorkspaceId = machine.workspaceId;
  await save();
  await machineState("running");
  const original = await db
    .selectFrom("development_environments")
    .select(["runtime_name", "allocation_id"])
    .where("id", "=", machine.environmentId)
    .executeTakeFirstOrThrow();
  instance = await client.read(original.runtime_name);
  assert(instance);
  report.machineRuntime = instance.sandboxId;
  await terminal(
    "printf BOX_WORKSPACE > /home/user/box-marker; printf BOX_ROOT > /etc/box-marker; mkdir -p /home/user/box-preview; printf '<!doctype html><title>Box Preview</title>BOX_PREVIEW_OK' > /home/user/box-preview/index.html; setsid python3 -m http.server 5173 --bind 0.0.0.0 --directory /home/user/box-preview </dev/null >/tmp/box-preview.log 2>&1 & sleep 1; curl -fsS http://127.0.0.1:5173/",
  );
  const localHttp = await client.runCommand(instance, {
    command: "curl -fsS http://127.0.0.1:5173/",
    cwd: "/home/user",
    user: "0:0",
    timeoutMs: 10000,
    maximumOutputBytes: 16384,
  });
  report.localHttpAfterTerminalClose = {
    exitCode: localHttp.exitCode,
    fixtureVisible: localHttp.stdout.includes("BOX_PREVIEW_OK"),
  };
  await save();
  assert.equal(localHttp.exitCode, 0, "Detached application did not survive terminal close");
  const response = await fetch(
    base + `/v1/development-environments/${machine.environmentId}/preview/5173/`,
    { headers: { authorization: "Bearer " + tenant.credential.token }, redirect: "manual" },
  );
  assert.equal(response.status, 307);
  const location = response.headers.get("location");
  await response.body?.cancel();
  const page = await readPreviewDocument(location, "127.0.0.1");
  assert.equal(page.status, 200, `Preview response: ${page.body.toString().slice(0, 512)}`);
  assert.match(page.body.toString(), /BOX_PREVIEW_OK/);
  report.checks.push("public-terminal-and-native-tcp-preview");
  await save();
  await api.developmentEnvironmentAction(
    machine.environmentId,
    "pause",
    newIdempotencyKey("pause"),
  );
  await machineState("paused");
  assert.equal((await client.read(instance.sandboxId)).state, "paused");
  await api.developmentEnvironmentAction(
    machine.environmentId,
    "resume",
    newIdempotencyKey("resume"),
  );
  await machineState("running");
  await terminal(
    'test "$(cat /home/user/box-marker)" = BOX_WORKSPACE; test "$(cat /etc/box-marker)" = BOX_ROOT',
  );
  report.checks.push("public-pause-resume-retains-disks");
  await save();
  await api.developmentEnvironmentAction(
    machine.environmentId,
    "release",
    newIdempotencyKey("release"),
  );
  await machineState("released");
  await until(async () => {
    const row = await db
      .selectFrom("workspaces")
      .select("storage_purged_at")
      .where("id", "=", machine.workspaceId)
      .executeTakeFirst();
    return !row || row.storage_purged_at;
  }, "dedicated Volume purge");
  report.checks.push("dedicated-release-and-exact-volume-cleanup");
  await save();
  project = await api.createProject("BoxLite idle expiry", { kind: "empty" }, backend);
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "BoxLite idle expiry",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "low", fastMode: false },
  );
  report.sessionId = session.sessionId;
  report.workspaceId = project.workspaceId;
  await save();
  const upload = await api.uploadWorkspaceFile(
    session.sessionId,
    randomUUID(),
    new Blob(["BOX_UPLOAD_RETAINED"]),
    "box-upload-marker.txt",
  );
  assert.match(upload.path, /^\/workspace\/[A-Za-z0-9_./-]+$/);
  report.checks.push("public-upload-without-cube-api");
  await run(
    "printf 'BOX_EXPIRY_RETAINED' > /workspace/box-expiry-marker && printf BOX_READY",
    "BOX_READY",
  );
  const row = await db
    .selectFrom("workspace_runtimes")
    .selectAll()
    .where("tenant_id", "=", tenant.tenantId)
    .where("workspace_id", "=", project.workspaceId)
    .where("state", "=", "allocated")
    .executeTakeFirstOrThrow();
  instance = await client.read(row.runtime_name);
  assert(instance);
  assert.equal(row.creation_spec.retentionWindowMs, 1800000);
  assert(row.idle_expires_at instanceof Date);
  report.originalDeadlineAt = row.idle_expires_at.toISOString();
  report.elasticRuntime = instance.sandboxId;
  await save();
  const changed = await db
    .updateTable("workspace_runtimes")
    .set({ idle_expires_at: new Date(Date.now() - 1000) })
    .where("workspace_runtime_id", "=", row.workspace_runtime_id)
    .where("tenant_id", "=", tenant.tenantId)
    .where("state", "=", "allocated")
    .where("allocation_closed", "=", false)
    .executeTakeFirstOrThrow();
  assert.equal(Number(changed.numUpdatedRows), 1);
  await until(async () => {
    const r = await db
      .selectFrom("workspace_runtimes")
      .select(["state", "allocation_closed"])
      .where("workspace_runtime_id", "=", row.workspace_runtime_id)
      .executeTakeFirstOrThrow();
    return r.state === "released" && r.allocation_closed;
  }, "platform expiry and positive closure");
  assert.equal(
    (await client.observe(instance.sandboxId, instance.nodeId, instance)).presence,
    "absent",
  );
  report.checks.push("platform-deadline-reclaims-stock-boxlite");
  await save();
  await run(
    `test "$(cat /workspace/box-expiry-marker)" = BOX_EXPIRY_RETAINED && test "$(cat '${upload.path}')" = BOX_UPLOAD_RETAINED && printf BOX_FILES_SURVIVED`,
    "BOX_FILES_SURVIVED",
  );
  const next = await db
    .selectFrom("workspace_runtimes")
    .select(["workspace_runtime_id", "runtime_name"])
    .where("tenant_id", "=", tenant.tenantId)
    .where("workspace_id", "=", project.workspaceId)
    .where("state", "=", "allocated")
    .executeTakeFirstOrThrow();
  assert.notEqual(next.workspace_runtime_id, row.workspace_runtime_id);
  assert.notEqual(next.runtime_name, row.runtime_name);
  report.checks.push("new-allocation-retains-workspace-after-expiry");
  report.accepted = true;
} catch (e) {
  failure = e;
  report.error = { name: e.name, message: e.message };
  await save();
}
try {
  if (active && session && !isTerminal(await api.getRun(active.runId))) {
    await api.cancelTurn(session.sessionId, active.turnId, newIdempotencyKey("cleanup"));
    await until(async () => isTerminal(await api.getRun(active.runId)), "cancel");
  }
  if (session) await api.deleteConversation(session.sessionId);
  if (project) {
    await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("cleanup-workspace"));
    await until(async () => {
      const r = await db
        .selectFrom("workspaces")
        .select("storage_purged_at")
        .where("id", "=", project.workspaceId)
        .executeTakeFirst();
      return !r || r.storage_purged_at;
    }, "elastic Workspace cleanup");
  }
  if (machine) {
    const row = await db
      .selectFrom("development_environments")
      .select(["state"])
      .where("id", "=", machine.environmentId)
      .executeTakeFirst();
    if (row && row.state !== "released")
      await api.developmentEnvironmentAction(
        machine.environmentId,
        "release",
        newIdempotencyKey("cleanup-machine"),
      );
    await machineState("released");
    await until(async () => {
      const r = await db
        .selectFrom("workspaces")
        .select("storage_purged_at")
        .where("id", "=", machine.workspaceId)
        .executeTakeFirst();
      return !r || r.storage_purged_at;
    }, "machine Workspace cleanup");
  }
  report.physicalCleanupConfirmed = true;
} catch (e) {
  report.cleanupError = { name: e.name, message: e.message };
  failure ??= e;
}
await save();
if (cubeOutage) {
  try {
    const stopped = JSON.parse(kubectl(["get", "deployment/cube-api", "-o", "json"]));
    assert.equal(
      stopped.spec.replicas,
      0,
      "Cube API recovered before the isolated lifecycle finished",
    );
    assert.equal(
      JSON.parse(kubectl(["get", "pods", "-l", cubeOutage.selector, "-o", "json"])).items.length,
      0,
    );
    report.cubeUnavailable.entireProductLifecycleAndPhysicalCleanup =
      report.accepted && report.physicalCleanupConfirmed;
  } catch (error) {
    failure ??= error;
    report.accepted = false;
    report.cubeUnavailable.failure = error.message;
  } finally {
    await cubeOutage.restore();
    kubectl(["rollout", "status", "deployment/cube-api", "--timeout=180s"], { timeout: 185_000 });
    report.cubeUnavailable.restored = true;
    await save();
  }
}
// Disposable ledger deletion waits for every known source to confirm delivery.
// This administrative barrier runs after the outage; it does not gate the
// product's independently completed VM/Workspace release above.
try {
  if (tenant && report.physicalCleanupConfirmed) {
    const blobs = new S3AttachmentBlobStore({
      endpoint: `http://${serviceAddress("session-images")}:8333`,
      region: "us-east-1",
      bucket: "pi-cloud-session-images",
      ...JSON.parse(await secret("session-image-s3-credentials.json")),
    });
    try {
      await purgeOwnedAcceptanceTenant(db, tenant, blobs);
    } finally {
      await blobs.close();
    }
    report.cleanupConfirmed = true;
  }
} catch (error) {
  report.cleanupError = { name: error.name, message: error.message };
  failure ??= error;
}
await save();
await client.close();
await db.destroy();
console.log(JSON.stringify(report));
if (failure) process.exitCode = 1;
