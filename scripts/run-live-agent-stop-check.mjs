import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { createDatabase } from "../packages/database/src/index.ts";
import { sql } from "kysely";
import { serviceAddress, kubectl } from "./lib/production-kubernetes.mjs";
import { execFileSync } from "node:child_process";

if (process.env.PI_CLOUD_LIVE_AGENT_STOP_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_AGENT_STOP_CHECK=1 for owned Luna/shared-VM cancellation acceptance",
  );
const runtime = "deploy/production/runtime";
const port = (await readFile(`${runtime}/.env`, "utf8")).match(/^PI_CLOUD_HTTP_PORT=(\d+)$/m)?.[1];
assert(port);
const api = new PiCloudApi(
  (url, init) => fetch(new URL(String(url), `http://127.0.0.1:${port}`), init),
  (await readFile(`${runtime}/secrets/api-token`, "utf8")).trim(),
);
const pgurl = new URL((await readFile(`${runtime}/secrets/database-url`, "utf8")).trim());
pgurl.hostname = serviceAddress("postgres");
const database = createDatabase({ connectionString: pgurl.toString(), maxConnections: 1 });
const report = { checkedAt: new Date().toISOString(), model: "gpt-6-luna", accepted: false };
const sessions = [],
  turns = [];
let project, failure, pausedApi;
const fault = process.env.PI_CLOUD_LIVE_TOOL_CANCEL_FAULT === "api_pause";
report.fault = fault ? "api_pause" : "none";
const terminal = (r) => ["completed", "failed", "cancelled", "timed_out"].includes(r.state);
async function until(fn, label, ms = 180000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await delay(250);
  }
  throw new Error(`Timed out: ${label}`);
}
const read = async (session, path) =>
  Buffer.from((await api.readWorkspaceFile(session.sessionId, path)).bytes).toString();
async function run(session, prompt) {
  const turn = await api.acceptTurn(
    session.sessionId,
    prompt,
    newIdempotencyKey("agent-stop"),
    "low",
  );
  turns.push({ session, turn });
  return turn;
}
async function settled(turn) {
  return until(async () => {
    const r = await api.getRun(turn.runId);
    return terminal(r) ? r : undefined;
  }, "Run settlement");
}
try {
  project = await api.createProject("Agent Stop survival " + Date.now());
  for (const name of ["cancelled scope", "surviving sibling"])
    sessions.push(
      await api.createSession(
        project.projectId,
        project.workspaceId,
        name,
        "elastic",
        "starter",
        "/workspace",
        { provider: "openai-codex", modelId: report.model, thinkingLevel: "low", fastMode: false },
      ),
    );
  const [first, sibling] = sessions;
  const prefix = `agent-stop-${randomUUID()}`;
  const background = `nohup sleep 180 >${prefix}.background.log 2>&1 </dev/null & echo $! > ${prefix}.background; printf BACKGROUND_STARTED`;
  const command = `printf 'started\\n' >> ${prefix}.count; printf '%s' $$ > ${prefix}.parent; sleep 120 & child=$!; printf '%s' "$child" > ${prefix}.child; setsid sleep 180 >${prefix}.independent.log 2>&1 </dev/null & printf '%s' "$!" > ${prefix}.independent; printf 'PARTIAL_BEFORE_CANCEL\\n'; wait "$child"; printf 'late\\n' > ${prefix}.late`;
  const cancelled = await run(
    first,
    `按顺序调用两次 bash。第一次 command 必须逐字使用这个 JSON 字符串：${JSON.stringify(background)}。等第一次返回后，第二次 command 必须逐字使用：${JSON.stringify(command)}，timeout 为 180。不要使用其他工具。第二次会由测试中断。`,
  );
  await until(async () => {
    try {
      return (
        (await read(first, `${prefix}.count`)) === "started\n" &&
        (await read(first, `${prefix}.child`)).length > 0
      );
    } catch {
      return false;
    }
  }, "first scope started");
  const peerCommand = `printf 'ready\\n' > ${prefix}.sibling; sleep 30; printf 'survived\\n' >> ${prefix}.sibling; printf 'SIBLING_SURVIVED'`;
  const peer = await run(
    sibling,
    `只调用一次 bash，command 必须逐字使用这个 JSON 字符串：${JSON.stringify(peerCommand)}，timeout 为 120。不要使用其他工具。完成后简短回复。`,
  );
  await until(async () => {
    try {
      return (await read(sibling, `${prefix}.sibling`)) === "ready\n";
    } catch {
      return false;
    }
  }, "sibling scope started");
  const { rows } =
    await sql`select count(distinct snapshot->>'physicalActivationId')::int as vms,count(*)::int as bindings
    from sandbox_tool_bindings where run_id in (${cancelled.runId}::uuid,${peer.runId}::uuid) and not dispatch_closed`.execute(
      database,
    );
  assert.deepEqual(rows[0], { vms: 1, bindings: 2 });
  report.sharedVmVerified = true;
  if (fault) {
    const { rows: foreign } = await sql`select count(*)::int as active from runs
      where state not in ('completed','failed','cancelled','timed_out') and not(id=any(${turns.map(({ turn }) => turn.runId)}::uuid[]))`.execute(
      database,
    );
    assert.equal(foreign[0].active, 0, "Refuse to pause Cube API while another Run is active");
    const pods = JSON.parse(
      kubectl([
        "get",
        "pods",
        "-l",
        "app.kubernetes.io/component=api,app.kubernetes.io/instance=cube",
        "-o",
        "json",
      ]),
    );
    assert.equal(pods.items.length, 1);
    const id = pods.items[0].status.containerStatuses
      .find((c) => c.name === "cube-api")
      .containerID.replace(/^containerd:\/\//, "");
    assert(/^[a-f0-9]{64}$/.test(id));
    execFileSync("/usr/local/bin/k3s", ["ctr", "-n", "k8s.io", "tasks", "pause", id]);
    pausedApi = id;
  }
  const cancellationAt = Date.now();
  await api.cancelTurn(first.sessionId, cancelled.turnId, newIdempotencyKey("cancel-owned-scope"));
  const cancelledRun = await settled(cancelled);
  assert.equal(cancelledRun.state, "cancelled", JSON.stringify(cancelledRun.failure));
  report.cancelMs = Date.now() - cancellationAt;
  if (pausedApi) {
    execFileSync("/usr/local/bin/k3s", ["ctr", "-n", "k8s.io", "tasks", "resume", pausedApi]);
    pausedApi = undefined;
  }
  assert(
    report.cancelMs < (fault ? 30000 : 15000),
    "Cancellation did not settle within its transport budgets",
  );
  // Completed launches and setsid descendants survive. An unfinished ordinary
  // Bash group must be gone after confirmed cancellation. Unknown makes no such
  // assertion, because cancellation may have been delayed by the API outage.
  const foreground = fault
    ? ""
    : `for f in ${prefix}.parent ${prefix}.child; do pid=$(cat "$f"); state=$(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null || true); case "$state" in ""|Z) ;; *) printf 'FOREGROUND_STILL_RUNNING'; exit 1;; esac; done; `;
  const verify =
    foreground +
    `for f in ${prefix}.background ${prefix}.independent; do pid=$(cat "$f"); state=$(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null || true); case "$state" in ""|Z) printf 'BACKGROUND_DIED_ON_CHAT_STOP'; exit 1;; esac; done; printf 'PI_CANCEL_BOUNDARY_CONFIRMED\\n'; for f in ${prefix}.background ${prefix}.independent ${prefix}.child ${prefix}.parent; do kill "$(cat "$f")" 2>/dev/null || true; done; printf 'EXPLICIT_PROCESS_CLEANUP'`;
  const checked = await run(
    first,
    `只调用一次 bash，command 必须逐字使用这个 JSON 字符串：${JSON.stringify(verify)}。不要使用其他工具，完成后简短回复。`,
  );
  const check = await settled(checked);
  assert.equal(check.state, "completed", JSON.stringify(check.failure));
  const detail = (await api.getConversation(first.sessionId)).turns.find(
    (t) => t.runId === checked.runId,
  );
  const tools = detail.transcript.items.filter((i) => i.kind === "tool");
  assert.equal(tools.length, 1);
  assert.equal(tools[0].status, "completed");
  assert(JSON.stringify(tools[0].output).includes("PI_CANCEL_BOUNDARY_CONFIRMED"));
  assert(JSON.stringify(tools[0].output).includes("EXPLICIT_PROCESS_CLEANUP"));
  report.foregroundCancellationConfirmed = !fault;
  report.completedBackgroundSurvived = true;
  report.independentProcessGroupSurvived = true;
  report.explicitProcessStopInNextRun = true;
  const survived = await settled(peer);
  assert.equal(survived.state, "completed", JSON.stringify(survived.failure));
  assert.equal(await read(sibling, `${prefix}.sibling`), "ready\nsurvived\n");
  assert.equal(await read(first, `${prefix}.count`), "started\n");
  const cancelledDetail = (await api.getConversation(first.sessionId)).turns.find(
    (t) => t.runId === cancelled.runId,
  );
  const stoppedTools = cancelledDetail.transcript.items.filter((item) => item.kind === "tool");
  assert.equal(stoppedTools.length, 2);
  assert.equal(stoppedTools[0].status, "completed");
  assert(
    ["failed", "unknown"].includes(stoppedTools[1].status),
    "Unfinished Tool was reported as successful",
  );
  // Native abort can discard a physical reply. Physical scope survival and
  // cancellation were checked separately; no reply-preservation claim is made.
  const retained = JSON.stringify(cancelledDetail.transcript);
  await delay(1000);
  const reloaded = (await api.getConversation(first.sessionId)).turns.find(
    (t) => t.runId === cancelled.runId,
  );
  assert.equal(JSON.stringify(reloaded.transcript), retained, "Late reply overwrote native abort");
  report.nativeAbortStable = true;
  report.siblingCompleted = true;
  report.executionCount = 1;
  report.accepted = true;
} catch (error) {
  failure = error;
} finally {
  const errors = [];
  if (pausedApi) {
    try {
      execFileSync("/usr/local/bin/k3s", ["ctr", "-n", "k8s.io", "tasks", "resume", pausedApi]);
    } catch (error) {
      errors.push(error);
    }
    pausedApi = undefined;
  }
  for (const { session, turn } of turns)
    try {
      if (!terminal(await api.getRun(turn.runId))) {
        await api.cancelTurn(session.sessionId, turn.turnId, newIdempotencyKey("cleanup"));
        await settled(turn);
      }
    } catch (error) {
      errors.push(error);
    }
  for (const session of sessions)
    try {
      await api.deleteConversation(session.sessionId);
    } catch (error) {
      errors.push(error);
    }
  if (project)
    try {
      await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("cleanup"));
    } catch (error) {
      errors.push(error);
    }
  await database.destroy();
  report.cleanupCompleted = errors.length === 0;
  await writeFile(
    process.argv[2] ?? "/tmp/pi-cloud-agent-stop-live.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
  if (failure || errors.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      "Pi Tool cancellation acceptance failed",
    );
}
