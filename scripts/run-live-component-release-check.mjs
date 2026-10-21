import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { uploadRelativePath } from "../packages/protocol/src/user-upload.ts";
import { parseModelCatalogConfiguration } from "../packages/protocol/src/model-catalog.ts";
import {
  runtimeDirectory,
  runtimeEnvironment,
  serviceAddress,
  kubectl,
} from "./lib/production-kubernetes.mjs";
import { nativeHistory, nativeMessages, runUsage } from "./lib/native-session-history.mjs";
import {
  settleOwnedAcceptanceRuns,
  purgeOwnedAcceptanceTenant,
} from "./lib/owned-acceptance-cleanup.mjs";
import { S3ImageBlobStore } from "../packages/session-attachments/src/s3.ts";
import { digest } from "./lib/component-release.mjs";

assert.equal(
  process.env.PI_CLOUD_LIVE_COMPONENT_RELEASE_CHECK,
  "1",
  "Authorize owned Luna/Cube fixtures and the prepared provider/catalog releases explicitly",
);
const [providerCandidate, reportDirectory] = process.argv.slice(2);
assert(providerCandidate && reportDirectory, "Pass PROVIDER_CANDIDATE PRIVATE_REPORT_DIRECTORY");
const directory = resolve(reportDirectory);
await mkdir(directory, { recursive: true, mode: 0o700 });
const report = { at: new Date().toISOString(), accepted: false, cleanupConfirmed: false, runs: [] };
const save = async (name, value) =>
  writeFile(resolve(directory, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
const phase = (name) => console.log(JSON.stringify({ phase: name, at: new Date().toISOString() }));
const release = (...args) =>
  execFileSync(
    process.execPath,
    ["--import", "tsx", "scripts/run-component-release.mjs", ...args],
    { stdio: "inherit", timeout: 600000 },
  );
const config = () =>
  parseModelCatalogConfiguration(
    JSON.parse(
      JSON.parse(kubectl(["get", "configmap", "pi-cloud-model-catalog", "-o", "json"])).data[
        "model-catalog.json"
      ],
    ),
  );
const original = config();
await save("original-catalog.json", original);
const changed = structuredClone(original),
  luna = changed.models.find(
    (m) => m.provider === "openai-codex" && m.modelId === "gpt-6-luna" && m.visible,
  );
assert(luna && luna.maxTokens > 16384, "Acceptance requires the reviewed Luna route");
luna.maxTokens = Math.floor(luna.maxTokens / 2);
await save("changed-catalog.json", changed);
const endpoint = new URL(
  (await readFile(resolve(runtimeDirectory, "secrets/database-url"), "utf8")).trim(),
);
endpoint.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: endpoint.toString(), maxConnections: 2 });
const terminal = (r) => ["completed", "failed", "cancelled", "timed_out"].includes(r.state);
const until = async (read, label, budget = 240000) => {
  const end = Date.now() + budget;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw Error(`${label} timed out`);
};
let tenant,
  api,
  project,
  failure,
  catalogChanged = false;
const sessions = [];
const settled = async (id) =>
  until(async () => {
    const r = await api.getRun(id);
    return terminal(r) ? r : false;
  }, "Run settlement");
const runRow = (id) =>
  db
    .selectFrom("runs")
    .select(["model_runtime_snapshot", "lease_id", "fencing_token", "worker_id", "state"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
function pods() {
  return JSON.parse(kubectl(["get", "pods", "-o", "json"]))
    .items.filter(
      (p) =>
        !p.metadata.deletionTimestamp &&
        !["Succeeded", "Failed"].includes(p.status.phase) &&
        !p.spec.containers.some((c) => c.name === "cli-proxy-api"),
    )
    .map((p) => ({
      name: p.metadata.name,
      uid: p.metadata.uid,
      images: p.spec.containers.map((c) => c.image),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
async function completed(id) {
  const state = await settled(id),
    history = await nativeHistory(db, { runId: id });
  report.runs.push({ runId: id, state: state.state, usage: runUsage(history) });
  assert.equal(state.state, "completed", "Owned native Run failed");
  return nativeMessages(history);
}
async function restoreCatalog() {
  if (!catalogChanged) return;
  // Finish recording an already-applied candidate before preparing its reverse publication.
  release("apply", resolve(directory, "catalog-change"));
  release(
    "prepare",
    "catalog",
    resolve(directory, "catalog-restore"),
    resolve(directory, "original-catalog.json"),
  );
  release("apply", resolve(directory, "catalog-restore"));
  assert.equal(digest(config()), digest(original));
  catalogChanged = false;
  report.catalogRestored = true;
}
try {
  const foreign = await db
    .selectFrom("runs")
    .select("id")
    .where("state", "in", ["queued", "running", "settling", "cancel_requested"])
    .execute();
  assert.equal(
    foreign.length,
    0,
    "Exclude unrelated active Runs before provider replacement acceptance",
  );
  tenant = await createPrivateTenant(db, {
    slug: `release-acceptance-${randomUUID()}`,
    ownerDisplayName: "Component release acceptance",
    initialModel: { provider: "openai-codex", modelId: "gpt-6-luna" },
  });
  report.tenantId = tenant.tenantId;
  await save("report.json", report);
  const base = `http://127.0.0.1:${runtimeEnvironment().PI_CLOUD_HTTP_PORT}`;
  api = new PiCloudApi(
    (url, init) => fetch(new URL(String(url), base), init),
    tenant.credential.token,
  );
  project = await api.createProject("Component release acceptance");
  const session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Active owner",
    "elastic",
  );
  sessions.push(session);
  const uploadId = randomUUID(),
    filename = "release-unblock.txt",
    path = `/workspace/${uploadRelativePath(uploadId, filename)}`;
  const active = await api.acceptTurn(
    session.sessionId,
    `Use bash once with timeout 600 seconds to run exactly: while [ ! -f '${path}' ]; do sleep 1; done; cat '${path}'; printf '\\nRELEASE_TOOL_DONE\\n'. The test operator will upload that file. After bash finishes, reply RELEASE_CONTINUED.`,
    newIdempotencyKey("component-live"),
  );
  await until(async () => {
    const row = await db
      .selectFrom("workspace_runtimes")
      .select(["workspace_runtime_id", "sandbox_id", "runtime_id"])
      .where("tenant_id", "=", tenant.tenantId)
      .where("state", "=", "active")
      .executeTakeFirst();
    return row?.runtime_id ? row : false;
  }, "Running Cube");
  const beforeRun = await runRow(active.runId),
    beforePods = pods();
  assert.equal(beforeRun.state, "running", "The fixture Run ended before rollout");
  const providerPod = () =>
    JSON.parse(
      kubectl(["get", "pods", "-l", "app.kubernetes.io/component=cli-proxy-api", "-o", "json"]),
    )
      .items.filter((p) => !p.metadata.deletionTimestamp)
      .map((p) => p.metadata.uid)
      .sort();
  const oldProvider = providerPod();
  const beforeVm = await db
    .selectFrom("workspace_runtimes")
    .select(["workspace_runtime_id", "sandbox_id", "runtime_id"])
    .where("tenant_id", "=", tenant.tenantId)
    .where("state", "=", "active")
    .execute();
  const beforeWorkers = await db
    .selectFrom("workers")
    .select(["id", "boot_id"])
    .where("terminated_at", "is", null)
    .orderBy("id")
    .execute();
  phase("replace provider while the native Tool waits");
  release("apply", resolve(providerCandidate));
  assert.deepEqual(pods(), beforePods, "Unrelated Pods restarted during provider release");
  assert.deepEqual(
    await runRow(active.runId),
    beforeRun,
    "Active owner changed during provider release",
  );
  const replacedProvider = providerPod();
  assert.notDeepEqual(replacedProvider, oldProvider, "Provider image did not roll out");
  report.providerIndependent = true;
  phase("publish catalog while the original Run remains active");
  release(
    "prepare",
    "catalog",
    resolve(directory, "catalog-change"),
    resolve(directory, "changed-catalog.json"),
  );
  catalogChanged = true;
  release("apply", resolve(directory, "catalog-change"));
  assert.equal((await api.getModelCatalog()).revision, digest(changed));
  assert.deepEqual(
    await runRow(active.runId),
    beforeRun,
    "Catalog rewrote accepted Run capabilities",
  );
  assert.deepEqual(pods(), beforePods, "Catalog restarted a workload");
  assert.deepEqual(
    await db
      .selectFrom("workers")
      .select(["id", "boot_id"])
      .where("terminated_at", "is", null)
      .orderBy("id")
      .execute(),
    beforeWorkers,
  );
  assert.deepEqual(
    await db
      .selectFrom("workspace_runtimes")
      .select(["workspace_runtime_id", "sandbox_id", "runtime_id"])
      .where("tenant_id", "=", tenant.tenantId)
      .where("state", "=", "active")
      .execute(),
    beforeVm,
  );
  assert.deepEqual(providerPod(), replacedProvider, "Catalog restarted the provider");
  report.preserved = {
    pods: true,
    workerBoots: true,
    sessionLease: true,
    cube: true,
    acceptedSnapshot: true,
  };
  const nextSession = await api.createSession(
    project.projectId,
    project.workspaceId,
    "New catalog Run",
    "elastic",
  );
  sessions.push(nextSession);
  const next = await api.acceptTurn(
    nextSession.sessionId,
    "Run bash printf NEW_CATALOG_RUN, then reply NEW_CATALOG_RUN.",
    newIdempotencyKey("component-new"),
  );
  const nextRow = await runRow(next.runId);
  assert.equal(nextRow.model_runtime_snapshot.maxTokens, luna.maxTokens);
  assert.equal(nextRow.model_runtime_snapshot.catalogRevision, digest(changed));
  const nextMessages = await completed(next.runId);
  assert(
    nextMessages.some(
      (m) =>
        m.role === "toolResult" &&
        m.toolName === "bash" &&
        !m.isError &&
        JSON.stringify(m.content).includes("NEW_CATALOG_RUN"),
    ),
  );
  report.newRunSnapshot = true;
  await api.uploadWorkspaceFile(
    session.sessionId,
    uploadId,
    new Blob(["CATALOG_GATE_OPEN"]),
    filename,
  );
  const oldMessages = await completed(active.runId);
  assert(
    oldMessages.some(
      (m) =>
        m.role === "toolResult" &&
        m.toolName === "bash" &&
        !m.isError &&
        JSON.stringify(m.content).includes("CATALOG_GATE_OPEN"),
    ),
  );
  report.originalRunContinued = true;
  await restoreCatalog();
  report.accepted = true;
} catch (error) {
  failure = error;
  report.failure = String(error?.message ?? error).slice(0, 700);
} finally {
  if (catalogChanged) {
    try {
      await restoreCatalog();
    } catch (error) {
      report.catalogRestoreFailure = String(error?.message ?? error).slice(0, 500);
      failure ??= error;
    }
  }
  try {
    for (const session of sessions) {
      const rows = await db
        .selectFrom("runs")
        .select(["id", "turn_id", "state"])
        .where("session_id", "=", session.sessionId)
        .execute();
      await settleOwnedAcceptanceRuns(api, session.sessionId, rows, settled);
      await until(
        async () =>
          !(
            await db
              .selectFrom("runs")
              .select("id")
              .where("session_id", "=", session.sessionId)
              .where("output_seal_id", "is not", null)
              .where("output_sealed_at", "is", null)
              .execute()
          ).length,
        "cleanup seals",
      );
      await api.deleteConversation(session.sessionId);
    }
    if (project) {
      await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("cleanup"));
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
        "physical Workspace purge",
      );
    }
    if (tenant) {
      await until(
        async () =>
          !(
            await db
              .selectFrom("outbox")
              .select("id")
              .where("tenant_id", "=", tenant.tenantId)
              .where("published_at", "is", null)
              .execute()
          ).length,
        "control cleanup",
      );
      const blobs = new S3ImageBlobStore({
        endpoint: `http://${serviceAddress("session-images")}:8333`,
        region: "us-east-1",
        bucket: "pi-cloud-session-images",
        ...JSON.parse(
          await readFile(
            resolve(runtimeDirectory, "secrets/session-image-s3-credentials.json"),
            "utf8",
          ),
        ),
      });
      try {
        report.cleanup = await purgeOwnedAcceptanceTenant(db, tenant, blobs);
      } finally {
        blobs.close();
      }
    }
    report.cleanupConfirmed = true;
  } catch (error) {
    report.cleanupFailure = String(error?.message ?? error).slice(0, 500);
    failure ??= error;
  }
  await db.destroy();
  await save("report.json", report);
  console.log(JSON.stringify(report));
  if (failure) throw failure;
}
