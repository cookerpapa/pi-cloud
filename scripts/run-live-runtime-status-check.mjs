import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as callback, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { sql } from "kysely";
import { createDatabase } from "../packages/database/src/index.ts";
import { createPrivateTenant } from "../packages/control-plane/src/tenant-administration.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";
import { withChromePage } from "./lib/chrome-cdp.mjs";

if (process.env.PI_CLOUD_LIVE_RUNTIME_STATUS_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_RUNTIME_STATUS_CHECK=1 for Luna/Cube/browser and owned process-fault acceptance",
  );
const runtime = "deploy/production/runtime",
  exec = promisify(callback);
const env = await readFile(`${runtime}/.env`, "utf8");
const port = env.match(/^PI_CLOUD_HTTP_PORT=(\d+)$/m)?.[1];
assert(port);
const base = `http://127.0.0.1:${port}`;
const pgurl = new URL((await readFile(`${runtime}/secrets/database-url`, "utf8")).trim());
pgurl.hostname = JSON.parse(
  execFileSync("docker", ["inspect", "pi-cloud-production-postgres-1"], { encoding: "utf8" }),
)[0].NetworkSettings.Networks["pi-cloud-production_database"].IPAddress;
const db = createDatabase({ connectionString: pgurl.toString(), maxConnections: 2 });
const report = {
  checkedAt: new Date().toISOString(),
  revision: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  scriptSha256: createHash("sha256")
    .update(await readFile(new URL(import.meta.url)))
    .digest("hex"),
  model: "gpt-6-luna",
  accepted: false,
  runs: [],
};
let tenant,
  api,
  project,
  session,
  active,
  stream,
  failure,
  paused = false,
  stoppedWorker,
  projectorStopped = false;
const controller = new AbortController(),
  observations = [],
  events = [];
let snapshots = 0;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeout = 180_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`${label} timed out`);
}
const terminal = (state) => ["completed", "failed", "cancelled", "timed_out"].includes(state);
const finished = (id) =>
  until(async () => {
    const run = await api.getRun(id);
    return terminal(run.state) && run;
  }, "Run settlement");
async function alone() {
  const { rows } =
    await sql`select id from runs where state in ('queued','running','settling','cancel_requested')`.execute(
      db,
    );
  assert.deepEqual(
    rows.map((r) => r.id),
    active ? [active.runId] : [],
    "Refuse fault during unrelated execution",
  );
}
async function logCount() {
  const { rows } =
    await sql`select count(*)::int n from pi_session_log where tenant_id=${tenant.tenantId} and session_id=${session.sessionId}`.execute(
      db,
    );
  return rows[0].n;
}
async function start(prompt) {
  active = await api.acceptTurn(
    session.sessionId,
    prompt,
    newIdempotencyKey("runtime-status"),
    "low",
  );
  return active;
}
async function toolStarted(name = "bash") {
  return until(
    () =>
      events.find(
        (e) => e.turnId === active.turnId && e.type === "tool.started" && e.toolName === name,
      ),
    "Tool start",
  );
}
function noteRun(kind, run) {
  const own = observations.filter((o) => o.runId === run.runId);
  report.runs.push({
    kind,
    runId: run.runId,
    state: run.state,
    phases: [...new Set(own.filter((o) => o.type === "run.activity").map((o) => o.phase))],
    pathConfirmations: own.filter((o) => o.type === "run.path").length,
  });
}
try {
  await alone();
  tenant = await createPrivateTenant(db, {
    slug: `runtime-status-${Date.now().toString(36)}`,
    ownerDisplayName: "Runtime status acceptance",
    initialModel: { provider: "openai-codex", modelId: report.model },
  });
  const apiFetch = (url, init = {}) =>
    fetch(new URL(String(url), base), {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        authorization: `Bearer ${tenant.credential.token}`,
      },
    });
  api = new PiCloudApi(apiFetch);
  project = await api.createProject("Runtime status acceptance", { kind: "empty" });
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Runtime status acceptance",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: report.model, thinkingLevel: "low", fastMode: false },
  );
  report.resources = {
    tenantId: tenant.tenantId,
    workspaceId: project.workspaceId,
    sessionId: session.sessionId,
  };
  stream = streamSessionEvents({
    sessionId: session.sessionId,
    signal: controller.signal,
    fetchImplementation: apiFetch,
    onSnapshot() {
      snapshots++;
    },
    onStatus() {},
    onRunObservation(value) {
      observations.push({ ...value, receivedAt: Date.now() });
    },
    onEvent(e) {
      events.push({
        type: e.type,
        turnId: e.turnId,
        seq: e.seq,
        at: Date.now(),
        ...(e.type === "tool.started" ? { toolName: e.payload.toolName } : {}),
      });
    },
  });
  void stream.catch(() => {});
  await withChromePage({}, async (page) => {
    await page.send("Page.addScriptToEvaluateOnNewDocument", {
      source: "localStorage.setItem('pi-cloud:ui-language','zh-CN')",
    });
    await page.send("Network.setExtraHTTPHeaders", {
      headers: { Authorization: `Bearer ${tenant.credential.token}` },
    });
    await page.navigate(`${base}/?session=${session.sessionId}`);
    await page.waitFor("document.querySelector('.product-composer textarea')", 30_000);
    const command =
      'python3 -u -c \'import os,time; f=open("path-witness.txt","a"); f.write("once\\n"); f.flush(); os.fsync(f.fileno()); f.close(); time.sleep(120); print("PATH_DONE")\'';
    await start(
      `先简短说明准备验证状态，然后严格依次执行四次工具：write 写 status.txt 内容 before；read 读取；edit 改成 after；最后只执行一次 bash，command 必须为 ${JSON.stringify(command)}，timeout 为 180 秒。不要后台、重定向、子代理或搜索。完成后简短确认。`,
    );
    const began = await toolStarted();
    const selector = `[data-conversation-turn-id="${active.turnId}"] .product-run-status`;
    await page.waitFor(
      `document.querySelector(${JSON.stringify(selector)})?.dataset.runPhase==='executing_tool'`,
      30_000,
    );
    await until(
      () =>
        observations.some(
          (o) =>
            o.runId === active.runId && o.type === "run.path" && o.receivedAt > began.at + 10_000,
        ),
      "Quiet path probe",
      40_000,
    );
    const before = await logCount();
    await alone();
    await exec("docker", ["pause", "pi-cloud-production-control-plane-1"]);
    paused = true;
    try {
      await page.waitFor(
        `document.querySelector(${JSON.stringify(selector)})?.textContent.includes('状态更新延迟')`,
        60_000,
      );
    } catch (error) {
      report.lastBrowserStatus = await page.evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
      throw error;
    }
    const { rows: leases } =
      await sql`select l.valid_until > clock_timestamp() as valid from runs r join session_leases l on l.lease_id=r.lease_id where r.id=${active.runId}::uuid`.execute(
        db,
      );
    assert.equal(leases[0].valid, true, "Projector outage must not revoke independent PG renewal");
    report.delayedStatusVisible = true;
    report.leaseSurvivedProjectorPause = true;
    const oldSnapshots = snapshots;
    await exec("docker", ["unpause", "pi-cloud-production-control-plane-1"]);
    paused = false;
    await exec("docker", ["kill", "--signal=KILL", "pi-cloud-production-control-plane-1"]);
    projectorStopped = true;
    await exec("docker", ["start", "pi-cloud-production-control-plane-1"]);
    projectorStopped = false;
    const recoveredAt = Date.now();
    await until(
      () =>
        snapshots > oldSnapshots &&
        observations.some(
          (o) => o.runId === active.runId && o.type === "run.path" && o.sentAt > recoveredAt,
        ),
      "Fresh path after Projector replacement",
      45_000,
    );
    assert.equal(
      await logCount(),
      before,
      "Silent probes or repeated phase snapshots entered native history",
    );
    report.nativeLogUnchangedDuringSilence = true;
    report.projectorReplaced = true;
    await page.waitFor(
      `document.querySelector(${JSON.stringify(selector)})?.textContent.includes('运行链路')`,
      20_000,
    );
    const done = await finished(active.runId);
    assert.equal(done.state, "completed", JSON.stringify(done.failure));
    await page.waitFor(`!document.querySelector(${JSON.stringify(selector)})`, 15_000);
    const bytes = Buffer.from(
      (await api.readWorkspaceFile(session.sessionId, "path-witness.txt")).bytes,
    ).toString();
    assert.equal(bytes, "once\n", "Tool was replayed during projection recovery");
    report.noToolReplay = true;
    noteRun("quiet-tool-projector-recovery", done);
    assert.equal(
      Buffer.from((await api.readWorkspaceFile(session.sessionId, "status.txt")).bytes)
        .toString()
        .trim(),
      "after",
    );

    await start("只执行一次 bash，command 为 sleep 90，timeout 为 120 秒。不要其他工具。");
    await toolStarted();
    await until(
      () =>
        observations.some(
          (o) =>
            o.runId === active.runId && o.type === "run.activity" && o.phase === "executing_tool",
        ),
      "Tool phase",
    );
    await api.cancelTurn(session.sessionId, active.turnId, newIdempotencyKey("cancel-status"));
    const cancelled = await finished(active.runId);
    assert.equal(cancelled.state, "cancelled");
    await page.waitFor("!document.querySelector('.product-run-status')", 15_000);
    const afterCancel = observations.length;
    await sleep(2_000);
    assert.equal(observations.length, afterCancel, "Cancelled turn received late observations");
    noteRun("cancel", cancelled);

    await start("只执行一次 bash，command 为 sleep 90，timeout 为 120 秒。不要其他工具。");
    await toolStarted();
    await alone();
    const current = await api.getRun(active.runId);
    const { rows: workers } =
      await sql`select supervisor_id from sandboxes where id=${current.workerId}::uuid`.execute(db);
    const prefix = env.match(/^PI_CLOUD_SUPERVISOR_ID_PREFIX=(.*)$/m)?.[1] ?? "pi-cloud-worker-";
    assert([`${prefix}1`, `${prefix}2`].includes(workers[0].supervisor_id));
    stoppedWorker =
      workers[0].supervisor_id === `${prefix}1` ? "supervisor-host" : "supervisor-host-1";
    await exec(process.execPath, [
      "scripts/production-compose.mjs",
      "stop",
      "--timeout",
      "0",
      stoppedWorker,
    ]);
    await exec(process.execPath, ["scripts/production-compose.mjs", "start", stoppedWorker]);
    stoppedWorker = undefined;
    const lost = await finished(active.runId);
    assert.notEqual(lost.state, "completed");
    await page.waitFor("!document.querySelector('.product-run-status')", 20_000);
    noteRun("worker-loss", lost);
    await until(
      async () => (await api.getConversation(session.sessionId)).session.state === "idle",
      "Recovery closure",
    );
    await start(
      "继续会话，只用 read 读取 status.txt，简短回答文件内容。不要重新执行之前的 bash，不要其他工具。",
    );
    const recovered = await finished(active.runId);
    assert.equal(recovered.state, "completed", JSON.stringify(recovered.failure));
    noteRun("new-run-after-worker-loss", recovered);
  });
  assert(
    report.runs.some((r) => r.phases.includes("waiting_model")),
    "No real model-wait observation",
  );
  report.accepted = true;
} catch (error) {
  failure = error;
} finally {
  const errors = [];
  const cleanup = async (work) => {
    try {
      await work();
    } catch (error) {
      errors.push(error);
    }
  };
  if (paused)
    await cleanup(() => exec("docker", ["unpause", "pi-cloud-production-control-plane-1"]));
  if (projectorStopped)
    await cleanup(() => exec("docker", ["start", "pi-cloud-production-control-plane-1"]));
  if (stoppedWorker)
    await cleanup(() =>
      exec(process.execPath, ["scripts/production-compose.mjs", "start", stoppedWorker]),
    );
  await cleanup(async () => {
    if (api && active && !terminal((await api.getRun(active.runId)).state)) {
      await api.cancelTurn(session.sessionId, active.turnId, newIdempotencyKey("cleanup"));
      await finished(active.runId);
    }
  });
  controller.abort();
  await stream?.catch(() => {});
  if (session)
    await cleanup(() => api.deleteConversation(session.sessionId, newIdempotencyKey("cleanup")));
  if (project)
    await cleanup(() => api.deleteWorkspace(project.workspaceId, newIdempotencyKey("cleanup")));
  if (tenant)
    await cleanup(() =>
      db
        .updateTable("tenant_api_credentials")
        .set({ revoked_at: new Date() })
        .where("credential_id", "=", tenant.credential.credentialId)
        .execute(),
    );
  report.cleanupRequested = errors.length === 0;
  await writeFile(
    process.argv[2] ?? "/tmp/pi-cloud-runtime-status-live.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  await db.destroy();
  if (failure || errors.length)
    throw new AggregateError(
      [failure, ...errors].filter(Boolean),
      "Runtime status acceptance failed",
    );
}
console.log(JSON.stringify(report));
