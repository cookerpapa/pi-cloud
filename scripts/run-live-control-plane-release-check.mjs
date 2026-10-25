import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { previewToolDefinition } from "../packages/control-plane/src/ordinary-tools/preview-tool.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { uploadRelativePath } from "../packages/protocol/src/user-upload.ts";
import { S3ImageBlobStore } from "../packages/session-attachments/src/s3.ts";
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

assert.equal(
  process.env.PI_CLOUD_LIVE_CONTROL_RELEASE_CHECK,
  "1",
  "Authorize the prepared Control Plane release and owned Luna/Cube fixture",
);
const [candidatePath, reportPath] = process.argv.slice(2);
assert(candidatePath && reportPath, "Pass CONTROL_PLANE_CANDIDATE PRIVATE_REPORT_DIRECTORY");
const candidate = resolve(candidatePath),
  directory = resolve(reportPath);
assert.equal(
  JSON.parse(await readFile(resolve(candidate, "candidate.json"), "utf8")).scope,
  "control-plane",
);
// Reject stale source/artifacts/topology before creating a paid model fixture.
execFileSync(
  process.execPath,
  ["--import", "tsx", "scripts/run-component-release.mjs", "preflight", candidate],
  { stdio: "inherit", timeout: 60_000 },
);
await mkdir(directory, { recursive: true, mode: 0o700 });
const report = { at: new Date().toISOString(), accepted: false, cleanupConfirmed: false };
const save = () =>
  writeFile(resolve(directory, "report.json"), JSON.stringify(report, null, 2) + "\n", {
    mode: 0o600,
  });
const phase = (name) => console.log(JSON.stringify({ phase: name, at: new Date().toISOString() }));
const url = new URL(
  (await readFile(resolve(runtimeDirectory, "secrets/database-url"), "utf8")).trim(),
);
url.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: url.toString(), maxConnections: 2 });
const base = `http://127.0.0.1:${runtimeEnvironment().PI_CLOUD_HTTP_PORT}`;
const terminal = (state) => ["completed", "failed", "cancelled", "timed_out"].includes(state);
async function until(read, label, budget = 300_000) {
  const end = Date.now() + budget;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await delay(300);
  }
  throw new Error(label + " timed out");
}
let tenant, api, project, session, run, failure;
const settled = (id) =>
  until(async () => {
    const r = await api.getRun(id);
    return terminal(r.state) ? r : false;
  }, "Run settlement");
const runIdentity = (id) =>
  db
    .selectFrom("runs")
    .select(["lease_id", "fencing_token", "worker_id", "state"])
    .where("id", "=", id)
    .executeTakeFirstOrThrow();
const workers = () =>
  db
    .selectFrom("workers")
    .select(["id", "boot_id"])
    .where("terminated_at", "is", null)
    .orderBy("id")
    .execute();
const vms = () =>
  db
    .selectFrom("workspace_runtimes")
    .select(["workspace_runtime_id", "runtime_id", "runtime_name"])
    .where("tenant_id", "=", tenant.tenantId)
    .where("state", "!=", "released")
    .orderBy("workspace_runtime_id")
    .execute();
const machines = () =>
  db
    .selectFrom("development_environments")
    .select([
      "id",
      "workspace_id",
      "allocation_id",
      "runtime_id",
      "runtime_name",
      "generation",
      "desired_state",
      "state",
    ])
    .where("state", "!=", "released")
    .orderBy("id")
    .execute();
function pods() {
  return JSON.parse(kubectl(["get", "pods", "-o", "json"]))
    .items.filter(
      (p) => !p.metadata.deletionTimestamp && !["Succeeded", "Failed"].includes(p.status.phase),
    )
    .map((p) => ({
      name: p.metadata.name,
      uid: p.metadata.uid,
      control: p.spec.containers.some((c) => c.name === "control-plane"),
      images: p.spec.containers.map((c) => c.image),
      restarts: p.status.containerStatuses?.map((c) => c.restartCount),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
try {
  assert.equal(
    (
      await db
        .selectFrom("runs")
        .select("id")
        .where("state", "in", ["queued", "running", "settling", "cancel_requested"])
        .execute()
    ).length,
    0,
    "Exclude unrelated active work from the replacement acceptance",
  );
  tenant = await createPrivateTenant(db, {
    slug: "release-acceptance-control-" + randomUUID(),
    ownerDisplayName: "Control Plane release acceptance",
    initialModel: { provider: "openai-codex", modelId: "gpt-6-luna" },
  });
  api = new PiCloudApi(
    (path, init) => fetch(new URL(String(path), base), init),
    tenant.credential.token,
  );
  project = await api.createProject("Control Plane release acceptance");
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Retained active Run",
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
    filename = "control-release-unblock.txt",
    path = `/workspace/${uploadRelativePath(uploadId, filename)}`;
  const command = `echo ONCE >> /workspace/control-release-count.txt
printf '<h1>Control release preview</h1>' > /workspace/index.html
nohup python3 -m http.server 5173 --bind 0.0.0.0 --directory /workspace >/tmp/control-release-server.log 2>&1 </dev/null &
while [ ! -f '${path}' ]; do sleep 0.2; done
cat '${path}'; echo CONTROL_RELEASE_TOOL_DONE`;
  run = await api.acceptTurn(
    session.sessionId,
    `Do exactly these steps without delegation or search. First call bash with timeout 300 seconds and command exactly this JSON string: ${JSON.stringify(command)}. The operator will upload the gate file; wait for this same Bash to finish. Then call preview for port 5173 and reply CONTROL_RELEASE_CONTINUED plus its application link.`,
    newIdempotencyKey("control-release"),
    "low",
  );
  report.runId = run.runId;
  await save();
  await until(async () => {
    const state = await api.getRun(run.runId);
    if (terminal(state.state)) {
      const messages = nativeMessages(await nativeHistory(db, { runId: run.runId }));
      report.runFailure = {
        state: state.state,
        failure: state.failure,
        modelErrors: messages
          .filter((m) => m.role === "assistant" && m.stopReason === "error")
          .map((m) => String(m.errorMessage ?? "Model request failed").slice(0, 1000)),
        tools: messages
          .filter((m) => m.role === "toolResult")
          .map((m) => ({
            name: m.toolName,
            error: m.isError,
            text: m.content
              .filter((p) => p.type === "text")
              .map((p) => p.text)
              .join("\n")
              .slice(0, 1000),
          })),
      };
      await save();
      throw new Error("Fixture ended before its gated Tool started");
    }
    try {
      const file = await api.readWorkspaceFile(session.sessionId, "control-release-count.txt");
      return Buffer.from(file.bytes).toString() === "ONCE\n";
    } catch {
      return false;
    }
  }, "Running original Cube command");
  const beforeRun = await runIdentity(run.runId),
    beforeWorkers = await workers(),
    beforeVms = await vms(),
    beforePods = pods(),
    beforeMachines = await machines();
  assert(beforeVms.length === 1 && beforeVms[0].runtime_id);
  assert.equal(beforeRun.state, "running");
  const beforeTools = getCurrentTools(
    nativeMessages(await nativeHistory(db, { runId: run.runId })),
  );
  const oldPreview = beforeTools.find((t) => t.name === "preview");
  assert(oldPreview);
  assert.notEqual(
    oldPreview.description,
    previewToolDefinition.description,
    "Candidate must include the intended ordinary preview description change",
  );
  report.before = {
    run: beforeRun,
    workers: beforeWorkers,
    vms: beforeVms,
    pods: beforePods,
    machines: beforeMachines,
  };
  await save();
  phase("replace only Control Plane while original Bash waits in the same VM");
  const started = Date.now();
  execFileSync(
    process.execPath,
    ["--import", "tsx", "scripts/run-component-release.mjs", "apply", candidate],
    { stdio: "inherit", timeout: 1_200_000 },
  );
  report.replacementMs = Date.now() - started;
  assert.deepEqual(await runIdentity(run.runId), beforeRun, "Original Run ownership changed");
  assert.deepEqual(await workers(), beforeWorkers, "A Worker boot changed");
  assert.deepEqual(await vms(), beforeVms, "The active VM allocation changed");
  assert.deepEqual(await machines(), beforeMachines, "An existing development machine changed");
  const afterPods = pods();
  assert.deepEqual(
    afterPods.filter((p) => !p.control),
    beforePods.filter((p) => !p.control),
    "Another workload restarted",
  );
  assert.notDeepEqual(
    afterPods.filter((p) => p.control).map((p) => p.uid),
    beforePods.filter((p) => p.control).map((p) => p.uid),
  );
  report.preserved = {
    workerBoots: true,
    sessionLease: true,
    fencingToken: true,
    cube: true,
    otherPods: true,
    existingDevelopmentMachines: true,
  };
  await save();
  phase("continue the same Run and observe the new tool directory on its next request");
  await api.uploadWorkspaceFile(
    session.sessionId,
    uploadId,
    new Blob(["CONTROL_RELEASE_GATE_OPEN"]),
    filename,
  );
  const completed = await settled(run.runId);
  assert.equal(completed.state, "completed", completed.failure?.code);
  const history = await nativeHistory(db, { runId: run.runId }),
    messages = nativeMessages(history);
  const results = messages.filter((m) => m.role === "toolResult");
  assert.equal(
    results.filter((m) => m.toolName === "bash").length,
    1,
    "The original Bash must not be replayed",
  );
  assert(
    results.some(
      (m) =>
        m.toolName === "bash" &&
        !m.isError &&
        JSON.stringify(m.content).includes("CONTROL_RELEASE_TOOL_DONE"),
    ),
  );
  assert(results.some((m) => m.toolName === "preview" && !m.isError));
  assert.equal(
    getCurrentTools(messages).find((t) => t.name === "preview")?.description,
    previewToolDefinition.description,
  );
  const count = await api.readWorkspaceFile(session.sessionId, "control-release-count.txt");
  assert.equal(Buffer.from(count.bytes).toString(), "ONCE\n");
  report.catalogUpdatedWithinRun = true;
  report.nativeToolContinuedOnce = true;
  report.usage = runUsage(history);
  report.accepted = true;
} catch (error) {
  failure = error;
  report.failure = String(error.message).slice(0, 700);
} finally {
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
      await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("control-release-cleanup"));
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
        "Owned VM and Volume cleanup",
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
        "Owned controls",
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
        await blobs.close();
      }
    }
    report.cleanupConfirmed = true;
  } catch (error) {
    report.cleanupFailure = String(error.message).slice(0, 500);
    failure ??= error;
  }
  await db.destroy();
  await save();
  console.log(
    JSON.stringify({
      accepted: report.accepted,
      cleanupConfirmed: report.cleanupConfirmed,
      replacementMs: report.replacementMs,
      failure: report.failure,
    }),
  );
  if (failure)
    throw new Error("Control Plane release acceptance failed; inspect private evidence", {
      cause: failure,
    });
}
