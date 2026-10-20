import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { sql } from "kysely";
import WebSocket from "ws";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { S3ImageBlobStore } from "../packages/session-attachments/src/s3.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { runtimeDirectory, serviceAddress } from "./lib/production-kubernetes.mjs";
import { readWorkerModelTimings } from "./lib/live-run-timing.mjs";
import { retireOwnedWorker } from "./lib/owned-worker-crash.mjs";
import {
  purgeOwnedAcceptanceTenant,
  settleOwnedAcceptanceRuns,
} from "./lib/owned-acceptance-cleanup.mjs";

if (process.env.PI_CLOUD_LIVE_MODEL_RUNTIME_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_MODEL_RUNTIME_CHECK=1 for an owned >15-minute Luna/Cube Run and graceful Worker retirement",
  );
const output = process.argv[2] ?? "/tmp/pi-cloud-model-runtime-live.json";
const report = {
  checkedAt: new Date().toISOString(),
  model: "gpt-6-luna",
  accepted: false,
  cleanupConfirmed: false,
  scriptSha256: createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex"),
};
const env = await readFile(runtimeDirectory + "/.env", "utf8");
const base = `http://127.0.0.1:${env.match(/^PI_CLOUD_HTTP_PORT=(\d+)$/m)?.[1]}`;
const endpoint = new URL(
  (await readFile(runtimeDirectory + "/secrets/database-url", "utf8")).trim(),
);
endpoint.hostname = serviceAddress("postgres");
const db = createDatabase({ connectionString: endpoint.toString(), maxConnections: 2 });
const save = () => writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
const phase = async (value) => {
  report.phase = value;
  await save();
  console.log(value);
};
const terminal = (state) => ["completed", "failed", "cancelled", "timed_out"].includes(state);
async function until(read, label, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} did not settle`);
}
let tenant, project, session, api, failure, terminalProject, terminalSession, terminalSocket;
let terminalOutput = "",
  terminalFrame,
  terminalFailure,
  terminalOpenedAt;
async function finished(id, timeout = 180000) {
  const run = await until(
    async () => {
      const r = await api.getRun(id);
      return terminal(r.state) && r;
    },
    "Run",
    timeout,
  );
  await until(async () => {
    const row = await db
      .selectFrom("runs")
      .select(["output_seal_id", "output_sealed_at"])
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    return !row.output_seal_id || row.output_sealed_at;
  }, "Native writer closure");
  return run;
}
async function runningTool(runId) {
  return until(async () => {
    const run = await api.getRun(runId);
    assert(!terminal(run.state), "Run ended before its required Tool");
    return (await api.getConversation(session.sessionId)).turns
      .find((t) => t.runId === runId)
      ?.transcript?.items.some((i) => i.kind === "tool" && i.status === "running");
  }, "Tool admission");
}
const submit = (text) =>
  api.acceptTurn(session.sessionId, text, newIdempotencyKey("model-runtime"), "low");

try {
  const schema = await db
    .selectFrom("kysely_migration")
    .select("name")
    .orderBy("name", "desc")
    .limit(1)
    .executeTakeFirstOrThrow();
  assert.equal(schema.name, "194_upload_lifetimes");
  const other = await db
    .selectFrom("runs")
    .select("id")
    .where("state", "in", ["queued", "running", "settling", "cancel_requested"])
    .limit(1)
    .execute();
  assert.equal(other.length, 0, "Other work is active; refusing live Worker retirement");
  tenant = await createPrivateTenant(db, {
    slug: `native-input-model-runtime-${randomUUID()}`,
    ownerDisplayName: "Model runtime acceptance",
    initialModel: { provider: "openai-codex", modelId: report.model },
  });
  api = new PiCloudApi(
    (url, init) => fetch(new URL(String(url), base), init),
    tenant.credential.token,
  );
  project = await api.createProject("Model runtime acceptance", { kind: "empty" });
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Unbounded native work",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: report.model, thinkingLevel: "low", fastMode: false },
  );
  report.resources = {
    tenantId: tenant.tenantId,
    projectId: project.projectId,
    workspaceId: project.workspaceId,
    sessionId: session.sessionId,
  };
  terminalProject = await api.createProject("Owned terminal lifetime", { kind: "empty" });
  terminalSession = await api.createSession(
    terminalProject.projectId,
    terminalProject.workspaceId,
    "Terminal-only compute",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: report.model, thinkingLevel: "low", fastMode: false },
  );
  Object.assign(report.resources, {
    terminalProjectId: terminalProject.projectId,
    terminalWorkspaceId: terminalProject.workspaceId,
    terminalSessionId: terminalSession.sessionId,
  });
  await save();
  const warmed = await api.acceptTurn(
    terminalSession.sessionId,
    "Call bash exactly once with command printf '%s\\n' TERMINAL_WARMED, then reply TERMINAL_WARMED. Do not use other tools or delegate.",
    newIdempotencyKey("terminal-warm"),
    "low",
  );
  assert.equal(warmed.kind, "run");
  report.terminalWarmRunId = warmed.runId;
  await save();
  const warmedOutcome = await finished(warmed.runId);
  assert.equal(warmedOutcome.state, "completed", warmedOutcome.failure?.code);
  terminalSocket = new WebSocket(
    `${base.replace("http:", "ws:")}/v1/conversations/${terminalSession.sessionId}/terminal`,
    { headers: { authorization: `Bearer ${tenant.credential.token}` }, handshakeTimeout: 15000 },
  );
  terminalSocket.on("error", (error) => {
    terminalFailure = error.message;
  });
  terminalSocket.on("message", (raw) => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === "workspace_terminal.ready") terminalFrame = frame;
    if (frame.type === "workspace_terminal.output")
      terminalOutput = (terminalOutput + Buffer.from(frame.data, "base64").toString("utf8")).slice(
        -32768,
      );
    if (frame.type === "workspace_terminal.error") terminalFailure = frame.code;
  });
  await until(async () => {
    if (terminalFailure) throw new Error(terminalFailure);
    return terminalFrame;
  }, "Owned terminal ready");
  terminalOpenedAt = performance.now();
  const terminalRuntime = () =>
    db
      .selectFrom("workspace_runtimes")
      .select(["workspace_runtime_id", "runtime_id"])
      .where("tenant_id", "=", tenant.tenantId)
      .where("workspace_id", "=", terminalProject.workspaceId)
      .where("state", "!=", "released")
      .orderBy("workspace_runtime_id")
      .execute();
  const originalTerminalRuntime = await terminalRuntime();
  assert.equal(originalTerminalRuntime.length, 1);
  assert(originalTerminalRuntime[0].runtime_id);
  const prompt = (n) =>
    `This is an owned runtime-lifetime acceptance. Call bash exactly once with command "sleep 240; printf '%s\\n' STAGE_${n} >> /workspace/model-runtime.txt" and timeout 270 seconds. Wait for it to finish, then reply only STAGE_${n}_DONE. Do not shorten the sleep, background it, use other tools or create subagents.`;
  await phase("start one Run with four sequential native inputs across the former time limits");
  const beganAt = Date.now(),
    began = performance.now();
  const root = await submit(prompt(1));
  assert.equal(root.kind, "run");
  report.longRunId = root.runId;
  await save();
  await runningTool(root.runId);
  const inputs = [];
  for (const n of [2, 3, 4]) {
    const input = await submit(prompt(n));
    assert.equal(input.kind, "input");
    assert.equal(input.runId, root.runId);
    inputs.push(input.inputId);
  }
  const final = await submit("Without using any tool, reply only LONG_MODEL_RUNTIME_OK.");
  assert.equal(final.kind, "input");
  assert.equal(final.runId, root.runId);
  inputs.push(final.inputId);
  await until(async () => {
    const queue = await api.getInputQueue(session.sessionId);
    return inputs.every((id) => queue.items.some((i) => i.inputId === id));
  }, "Native queued inputs");
  const outcome = await finished(root.runId, 1800000);
  assert.equal(outcome.state, "completed", outcome.failure?.code);
  const content = Buffer.from(
    (await api.readWorkspaceFile(session.sessionId, "model-runtime.txt")).bytes,
  ).toString("utf8");
  assert.equal(content, "STAGE_1\nSTAGE_2\nSTAGE_3\nSTAGE_4\n");
  const timings = await readWorkerModelTimings([root.runId], beganAt);
  assert(timings.length >= 5);
  assert.equal(
    new Set(timings.map((t) => t.processStartedAtMs)).size,
    1,
    "A replacement would reset a short-lived grant and weaken this gate",
  );
  const spanMs = timings.at(-1).receivedMonotonicMs - timings[0].receivedMonotonicMs;
  assert(spanMs > 900000, "No model request crossed the old fifteen-minute capability TTL");
  const recovery = await db
    .selectFrom("run_transitions")
    .select("id")
    .where("run_id", "=", root.runId)
    .where("reason", "=", "native_execution_recovery")
    .execute();
  assert.equal(recovery.length, 0, "Long work must not pass by restarting its owner");
  const longTurn = (await api.getConversation(session.sessionId)).turns.find(
    (t) => t.runId === root.runId,
  );
  assert(
    longTurn.transcript.items
      .filter((i) => i.kind === "text")
      .some((i) => i.text.includes("LONG_MODEL_RUNTIME_OK")),
  );
  report.longWork = {
    accepted: true,
    elapsedMs: Math.round(performance.now() - began),
    modelRequestSpanMs: Math.round(spanMs),
    modelRequests: timings.length,
    sameRun: true,
    oneWorkerProcess: true,
    recoveryCount: 0,
    sequentialToolEffects: 4,
    nativeInputs: inputs.length,
  };
  assert.equal(terminalSocket.readyState, WebSocket.OPEN, terminalFailure);
  const terminalMarker = `TERMINAL_ALIVE_${randomUUID().replaceAll("-", "")}`;
  terminalSocket.send(
    JSON.stringify({
      workspaceTerminalProtocolVersion: 1,
      type: "workspace_terminal.input",
      data: Buffer.from(`printf '\\n%s\\n' '${terminalMarker}'\r`).toString("base64"),
    }),
  );
  await until(
    async () => new RegExp(`(?:^|[\\r\\n])${terminalMarker}\\r?\\n`).test(terminalOutput),
    "Same terminal after warm TTL",
  );
  assert.deepEqual(await terminalRuntime(), originalTerminalRuntime);
  assert(performance.now() - terminalOpenedAt > 900000);
  report.terminalHolder = {
    accepted: true,
    heldMs: Math.round(performance.now() - terminalOpenedAt),
    sameConnection: true,
    samePhysicalRuntime: true,
    pid: terminalFrame.pid,
  };
  await save();

  await phase("gracefully replace the owned Worker while a Tool and follow-up are pending");
  const handoff = await submit(
    "Call bash ONCE: printf '%s\\n' ONCE >> /workspace/worker-handoff-once.txt; sleep 120; printf FIRST_DONE. Set timeout to 150 seconds. If the Tool is interrupted or unknown, NEVER repeat this command; use read to inspect worker-handoff-once.txt instead. Then reply HANDOFF_ROOT_OK. Do not create subagents.",
  );
  assert.equal(handoff.kind, "run");
  report.handoffRunId = handoff.runId;
  await save();
  await runningTool(handoff.runId);
  await until(async () => {
    try {
      return (
        Buffer.from(
          (await api.readWorkspaceFile(session.sessionId, "worker-handoff-once.txt")).bytes,
        ).toString("utf8") === "ONCE\n"
      );
    } catch (e) {
      if (["not_found", "unavailable"].includes(e.code)) return false;
      throw e;
    }
  }, "First confirmed physical effect");
  const queued = await submit("After the current work, without tools reply HANDOFF_INPUT_OK.");
  assert.equal(queued.kind, "input");
  assert.equal(queued.runId, handoff.runId);
  await until(
    async () =>
      (await api.getInputQueue(session.sessionId)).items.some((i) => i.inputId === queued.inputId),
    "Persisted follow-up",
  );
  report.retirement = await retireOwnedWorker(db, tenant.tenantId, handoff.runId);
  await save();
  const result = await finished(handoff.runId, 240000);
  assert.equal(result.state, "completed", result.failure?.code);
  const after = Buffer.from(
    (await api.readWorkspaceFile(session.sessionId, "worker-handoff-once.txt")).bytes,
  ).toString("utf8");
  assert.equal(after, "ONCE\n");
  const turn = (await api.getConversation(session.sessionId)).turns.find(
    (t) => t.runId === handoff.runId,
  );
  const answer = turn.transcript.items
    .filter((i) => i.kind === "text")
    .map((i) => i.text)
    .join("\n");
  assert(answer.includes("HANDOFF_INPUT_OK"));
  const resumed = await db
    .selectFrom("run_transitions")
    .select("id")
    .where("run_id", "=", handoff.runId)
    .where("reason", "=", "native_execution_recovery")
    .execute();
  assert(resumed.length > 0);
  const all = await db
    .selectFrom("runs")
    .select("id")
    .where("tenant_id", "=", tenant.tenantId)
    .where("session_id", "=", session.sessionId)
    .execute();
  assert.equal(all.length, 2);
  report.handoff = {
    accepted: true,
    sameRun: true,
    followUpConsumed: true,
    onePhysicalAppend: true,
    recoveryCount: resumed.length,
    exitCode: report.retirement.exitCode,
  };
  report.accepted = true;
  await phase("acceptance passed; clean owned physical resources");
} catch (error) {
  failure = error;
  report.failure = {
    name: error.name,
    code: error.code,
    status: error.status,
    message: String(error.message).slice(0, 300),
  };
} finally {
  const errors = [],
    clean = async (action) => {
      try {
        await action();
      } catch (e) {
        errors.push({ name: e.name, code: e.code });
      }
    };
  if (terminalSocket)
    await clean(async () => {
      if (terminalSocket.readyState !== WebSocket.CLOSED)
        await new Promise((resolve) => {
          const timer = setTimeout(() => terminalSocket.terminate(), 5000);
          terminalSocket.once("close", () => {
            clearTimeout(timer);
            resolve();
          });
          terminalSocket.close();
        });
    });
  if (terminalSession)
    await clean(async () => {
      const rows = await db
        .selectFrom("runs")
        .select(["id", "turn_id"])
        .where("tenant_id", "=", tenant.tenantId)
        .where("session_id", "=", terminalSession.sessionId)
        .execute();
      await settleOwnedAcceptanceRuns(api, terminalSession.sessionId, rows, finished);
      await api.deleteConversation(terminalSession.sessionId);
    });
  if (terminalProject)
    await clean(async () => {
      await api.deleteWorkspace(terminalProject.workspaceId, newIdempotencyKey("terminal-clean"));
      await until(
        async () =>
          Boolean(
            (
              await db
                .selectFrom("workspaces")
                .select("storage_purged_at")
                .where("id", "=", terminalProject.workspaceId)
                .executeTakeFirst()
            )?.storage_purged_at,
          ),
        "Terminal Workspace physical purge",
      );
    });
  if (session)
    await clean(async () => {
      const rows = await db
        .selectFrom("runs")
        .select(["id", "turn_id"])
        .where("tenant_id", "=", tenant.tenantId)
        .where("session_id", "=", session.sessionId)
        .execute();
      await settleOwnedAcceptanceRuns(api, session.sessionId, rows, finished);
      await api.deleteConversation(session.sessionId);
    });
  if (project)
    await clean(async () => {
      await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("model-runtime-clean"));
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
        "Physical Workspace purge",
      );
    });
  if (tenant && !errors.length)
    await clean(async () => {
      const blobs = new S3ImageBlobStore({
        endpoint: `http://${serviceAddress("session-images")}:8333`,
        region: "us-east-1",
        bucket: "pi-cloud-session-images",
        ...JSON.parse(
          await readFile(runtimeDirectory + "/secrets/session-image-s3-credentials.json", "utf8"),
        ),
      });
      try {
        report.cleanup = await purgeOwnedAcceptanceTenant(db, tenant, blobs);
        report.cleanupConfirmed = true;
      } finally {
        blobs.close();
      }
    });
  report.cleanupErrors = errors;
  await save();
  await db.destroy();
  if (failure || errors.length)
    throw new Error("Model runtime live acceptance did not pass; inspect its private report");
}
console.log(
  JSON.stringify({
    accepted: report.accepted,
    longWork: report.longWork,
    handoff: report.handoff,
    cleanupConfirmed: report.cleanupConfirmed,
  }),
);
