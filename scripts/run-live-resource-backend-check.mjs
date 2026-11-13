import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { PiCloudApi } from "../packages/web-ui/src/api.ts";
import { newIdempotencyKey } from "@pi-cloud/session-client";
import { uploadRelativePath } from "../packages/protocol/src/user-upload.ts";
import { S3AttachmentBlobStore } from "../packages/session-attachments/src/s3.ts";
import {
  runtimeDirectory,
  runtimeEnvironment,
  serviceAddress,
  kubectl,
} from "./lib/production-kubernetes.mjs";
import { nativeHistory, nativeMessages } from "./lib/native-session-history.mjs";
import {
  settleOwnedAcceptanceRuns,
  purgeOwnedAcceptanceTenant,
} from "./lib/owned-acceptance-cleanup.mjs";
import { withChromePage } from "./lib/chrome-cdp.mjs";

assert.equal(
  process.env.PI_CLOUD_LIVE_RESOURCE_BACKEND_CHECK,
  "1",
  "Opt into owned model/VM and backend registration acceptance",
);
const output = resolve(process.argv[2]);
await mkdir(dirname(output), { recursive: true, mode: 0o700 });
const secret = async (name) =>
  (await readFile(resolve(runtimeDirectory, "secrets", name), "utf8")).trim();
const url = new URL(await secret("database-url"));
url.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
const base = `http://127.0.0.1:${runtimeEnvironment().PI_CLOUD_HTTP_PORT}`;
const apiFor = (token) => new PiCloudApi((path, init) => fetch(new URL(path, base), init), token);
const admin = apiFor(await secret("api-token"));
const report = {
  startedAt: new Date().toISOString(),
  accepted: false,
  cleanupConfirmed: false,
  checks: [],
};
const save = () => writeFile(output, JSON.stringify(report, null, 2), { mode: 0o600 });
const terminal = (r) => ["completed", "failed", "cancelled", "timed_out"].includes(r.state);
async function until(read, label, ms = 300_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(300);
  }
  throw new Error(`Timed out: ${label}`);
}
const pods = () =>
  JSON.parse(kubectl(["get", "pods", "-o", "json"]))
    .items.filter(
      (p) => !p.metadata.deletionTimestamp && !["Succeeded", "Failed"].includes(p.status.phase),
    )
    .map((p) => ({
      name: p.metadata.name,
      uid: p.metadata.uid,
      restarts: p.status.containerStatuses?.map((c) => c.restartCount),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
let tenant, api, project, session, run, backend, failure;
const settled = (id) =>
  until(async () => {
    const r = await api.getRun(id);
    return terminal(r) ? r : false;
  }, "Run settlement");
const identity = () =>
  db
    .selectFrom("runs")
    .select(["worker_id", "lease_id", "fencing_token"])
    .where("id", "=", run.runId)
    .executeTakeFirstOrThrow();
try {
  const existing = (await admin.resourceBackends(true)).backends;
  assert(
    !existing.some((b) => b.provider === "boxlite" && b.state === "active"),
    "Use an unregistered owned Box node for the no-restart scenario",
  );
  tenant = await createPrivateTenant(db, {
    slug: `release-acceptance-backends-${randomUUID().slice(0, 8)}`,
    ownerDisplayName: "Backend acceptance",
    initialModel: { provider: "openai-codex", modelId: "gpt-6-luna" },
  });
  api = apiFor(tenant.credential.token);
  project = await api.createProject("Backend registration retention", { kind: "empty" });
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Keep the original writer",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "low", fastMode: false },
  );
  report.resources = {
    tenantId: tenant.tenantId,
    workspaceId: project.workspaceId,
    sessionId: session.sessionId,
  };
  await save();
  const uploadId = randomUUID(),
    filename = "backend-unblock.txt",
    gate = `/workspace/${uploadRelativePath(uploadId, filename)}`;
  const command = `echo ONCE >> /workspace/backend-once.txt\nwhile [ ! -f '${gate}' ]; do sleep 0.2; done\ncat '${gate}'; echo BACKEND_REGISTRATION_CONTINUED`;
  run = await api.acceptTurn(
    session.sessionId,
    `Use bash exactly once with timeout 300 seconds and this exact command: ${JSON.stringify(command)}. The operator will upload the file. Wait for this same command, then reply BACKEND_REGISTRATION_CONTINUED. Do not search or delegate.`,
    newIdempotencyKey("backend-check"),
    "low",
  );
  report.runId = run.runId;
  await save();
  await until(async () => {
    const r = await api.getRun(run.runId);
    assert(!terminal(r), `Run ended before the held Tool: ${r.failure?.code ?? r.state}`);
    try {
      return (
        Buffer.from(
          (await api.readWorkspaceFile(session.sessionId, "backend-once.txt")).bytes,
        ).toString() === "ONCE\n"
      );
    } catch {
      return false;
    }
  }, "held original Tool");
  const before = {
    pods: pods(),
    writer: await identity(),
    runtimes: await db
      .selectFrom("workspace_runtimes")
      .select(["workspace_runtime_id", "runtime_id", "runtime_name"])
      .where("tenant_id", "=", tenant.tenantId)
      .where("state", "=", "allocated")
      .execute(),
  };
  assert.equal(before.runtimes.length, 1);
  report.before = before;
  await save();
  const config = JSON.parse(await readFile(resolve(runtimeDirectory, "k3s/boxlite.json"), "utf8"));
  const guest = JSON.parse(
    await readFile(resolve(runtimeDirectory, "cubesandbox/template.json"), "utf8"),
  );
  const backendId =
    process.env.PI_CLOUD_LIVE_BACKEND_ID ?? `sandbox-domain-box-${randomUUID().slice(0, 8)}`;
  const name = `BoxLite acceptance ${randomUUID().slice(0, 6)}`;
  await withChromePage({}, async (page) => {
    await page.send("Network.setExtraHTTPHeaders", {
      headers: { Authorization: `Bearer ${tenant.credential.token}` },
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
    await page.evaluate(
      "[...document.querySelector('.product-resource-tabs').querySelectorAll('button')].find(b=>b.textContent.includes('云端开发机')).click()",
    );
    await page.waitFor("document.querySelector('select[aria-label=集群]')");
    await page.evaluate("window.__backendRegistrationPageMarker='original-page'");
    backend = await admin.putResourceBackend({
      id: backendId,
      name,
      location: "Owned local acceptance",
      state: "active",
      expectedRevision: 0,
      configuration: {
        compute: {
          provider: "boxlite",
          url: config.url,
          nodeId: config.nodeId,
          token: await secret("sandbox-control-token"),
        },
        storage: {
          url: "http://workspace-volume-gateway:4500",
          token: await secret("workspace-volume-gateway-token"),
        },
        webProxy: {
          host: runtimeEnvironment().PI_CLOUD_CUBESANDBOX_EGRESS_PROXY_HOST ?? "10.255.255.254",
          port: 3128,
          directPrivateCidrs: [],
        },
        templates: [
          {
            id: "linux",
            name: "Linux",
            operatingSystem: "Linux",
            imageRevision: guest.imageRevision,
            elasticTemplateId: "tool",
            profiles: { starter: "starter", standard: "standard", performance: "performance" },
          },
        ],
      },
    });
    report.backendId = backend.id;
    await save();
    await page.waitFor(
      `[...document.querySelectorAll('select[aria-label=集群] option')].some(o=>o.textContent.includes(${JSON.stringify(name)}))`,
      60_000,
    );
    assert.equal(await page.evaluate("window.__backendRegistrationPageMarker"), "original-page");
    await page.screenshot(output + ".png");
  });
  assert.deepEqual(pods(), before.pods, "Registration restarted a platform process");
  assert.deepEqual(
    await identity(),
    before.writer,
    "Registration changed the original Session writer",
  );
  assert.deepEqual(
    await db
      .selectFrom("workspace_runtimes")
      .select(["workspace_runtime_id", "runtime_id", "runtime_name"])
      .where("tenant_id", "=", tenant.tenantId)
      .where("state", "=", "allocated")
      .execute(),
    before.runtimes,
  );
  report.checks.push(
    "already-open-page-discovered-backend",
    "original-pods-writer-and-vm-retained",
  );
  await api.uploadWorkspaceFile(
    session.sessionId,
    uploadId,
    new Blob(["BACKEND_GATE_OPEN"]),
    filename,
  );
  const complete = await settled(run.runId);
  assert.equal(complete.state, "completed", complete.failure?.code);
  assert.equal(
    Buffer.from(
      (await api.readWorkspaceFile(session.sessionId, "backend-once.txt")).bytes,
    ).toString(),
    "ONCE\n",
  );
  const messages = nativeMessages(await nativeHistory(db, { runId: run.runId }));
  assert(
    messages.some(
      (m) =>
        m.role === "toolResult" &&
        !m.isError &&
        JSON.stringify(m.content).includes("BACKEND_REGISTRATION_CONTINUED"),
    ),
  );
  report.checks.push("original-tool-completed-once");
  report.accepted = true;
} catch (error) {
  failure = error;
  report.error = String(error.message).slice(0, 800);
}
try {
  if (session) {
    const rows = await db
      .selectFrom("runs")
      .select(["id", "turn_id"])
      .where("session_id", "=", session.sessionId)
      .execute();
    await settleOwnedAcceptanceRuns(api, session.sessionId, rows, settled);
    await api.deleteConversation(session.sessionId);
  }
  if (project) {
    await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("backend-cleanup"));
    await until(
      async () =>
        Boolean(
          (
            await db
              .selectFrom("workspaces")
              .select("storage_purged_at")
              .where("id", "=", project.workspaceId)
              .executeTakeFirst()
          )?.storage_purged_at,
        ),
      "owned physical storage cleanup",
    );
  }
  if (tenant) {
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
  }
  // The registered backend intentionally remains for the subsequent owned
  // BoxLite lifecycle checks. It is disabled before returning the optional node to standby.
  report.cleanupConfirmed = true;
} catch (error) {
  report.cleanupError = String(error.message).slice(0, 600);
  failure ??= error;
}
await save();
await db.destroy();
console.log(
  JSON.stringify({
    accepted: report.accepted,
    checks: report.checks,
    backendId: report.backendId,
    cleanupConfirmed: report.cleanupConfirmed,
    error: report.error,
    cleanupError: report.cleanupError,
  }),
);
if (failure) process.exitCode = 1;
