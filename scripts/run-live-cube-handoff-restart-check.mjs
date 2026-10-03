import { serviceAddress, kubectlAsync, podFor } from "./lib/production-kubernetes.mjs";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { createDatabase } from "../packages/database/src/index.ts";
import { sql } from "kysely";
if (process.env.PI_CLOUD_LIVE_CONTROL_PLANE_RESTART_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_CONTROL_PLANE_RESTART_CHECK=1 for a disposable Luna/Cube Run and control-plane SIGKILL",
  );
const root = fileURLToPath(new URL("..", import.meta.url));
const runtime = resolve(
  root,
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);
const reportPath = process.argv[2] ?? "/tmp/pi-cloud-cube-handoff-restart.json";
const exec = promisify(execFile);
const port = (await readFile(runtime + "/.env", "utf8")).match(/^PI_CLOUD_HTTP_PORT=(\d+)$/m)[1];
const api = new PiCloudApi(
  (url, init) => fetch(new URL(String(url), `http://127.0.0.1:${port}`), init),
  (await readFile(runtime + "/secrets/api-token", "utf8")).trim(),
);
const terminal = (r) => ["completed", "failed", "cancelled", "timed_out"].includes(r.state);
async function waitFor(fn, label, ms = 120000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const result = await fn();
    if (result) return result;
    await delay(300);
  }
  throw Error("Timed out: " + label);
}
let project, session, turn, error;
const report = { checkedAt: new Date().toISOString(), model: "gpt-6-luna", accepted: false };
async function assertOnlyOwnedRun() {
  const url = new URL((await readFile(runtime + "/secrets/database-url", "utf8")).trim());
  url.hostname = serviceAddress("postgres");
  const db = createDatabase({ connectionString: url.toString(), maxConnections: 1 });
  try {
    const { rows } =
      await sql`select id from runs where state not in ('completed','failed','cancelled','timed_out')`.execute(
        db,
      );
    assert.deepEqual(
      rows.map((r) => r.id),
      [turn.runId],
      "Refuse fault injection while another Run is active",
    );
  } finally {
    await db.destroy();
  }
}

try {
  project = await api.createProject("Cube handoff restart " + Date.now());
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Cube handoff restart",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "low", fastMode: false },
  );
  turn = await api.acceptTurn(
    session.sessionId,
    "只调用一次 bash，命令必须为：printf 'started\\n' >> once.txt; sleep 45; printf 'finished\\n' >> once.txt; printf 'CUBE_HANDOFF_SURVIVED'。不要调用其他工具，不要搜索、不要子代理。完成后只回复 CUBE_HANDOFF_SURVIVED。",
    newIdempotencyKey("handoff"),
    "low",
  );
  report.runId = turn.runId;
  await waitFor(async () => {
    const r = await api.getRun(turn.runId);
    if (terminal(r)) throw Error("Run ended before fault " + JSON.stringify(r.failure));
    try {
      return (
        Buffer.from(
          (await api.readWorkspaceFile(session.sessionId, "once.txt")).bytes,
        ).toString() === "started\n"
      );
    } catch {
      return false;
    }
  }, "native Bash start");
  const before = await api.getRun(turn.runId);
  report.workerId = before.workerId;
  await assertOnlyOwnedRun();
  await kubectlAsync([
    "delete",
    "pod",
    podFor("control-plane"),
    "--grace-period=0",
    "--force",
    "--wait=true",
  ]);
  await kubectlAsync(["rollout", "status", "deployment/pi-cloud-control-plane", "--timeout=180s"]);
  const finished = await waitFor(
    async () => {
      try {
        const r = await api.getRun(turn.runId);
        return terminal(r) ? r : undefined;
      } catch {
        return undefined;
      }
    },
    "Run completion",
    180000,
  );
  assert.equal(finished.state, "completed", JSON.stringify(finished.failure));
  assert.equal(finished.workerId, before.workerId);
  const transcript = (await api.getConversation(session.sessionId)).turns.find(
    (t) => t.runId === turn.runId,
  ).transcript;
  const tools = transcript.items.filter((i) => i.kind === "tool");
  assert.equal(tools.length, 1);
  assert.equal(tools[0].status, "completed");
  assert.equal(
    Buffer.from((await api.readWorkspaceFile(session.sessionId, "once.txt")).bytes).toString(),
    "started\nfinished\n",
  );
  report.accepted = true;
  report.executionCount = 1;
  report.workerUnchanged = true;
  report.cubeCompletedAcrossControlPlaneLoss = true;
} catch (e) {
  error = e;
} finally {
  const cleanup = [];
  if (turn && session) {
    try {
      const r = await api.getRun(turn.runId);
      if (!terminal(r)) {
        await api.cancelTurn(session.sessionId, turn.turnId, newIdempotencyKey("cleanup"));
        await waitFor(async () => terminal(await api.getRun(turn.runId)), "cancel");
      }
    } catch (e) {
      cleanup.push(e);
    }
  }
  if (session) await api.deleteConversation(session.sessionId).catch((e) => cleanup.push(e));
  if (project)
    await api
      .deleteWorkspace(project.workspaceId, newIdempotencyKey("cleanup-workspace"))
      .catch((e) => cleanup.push(e));
  report.cleanupCompleted = cleanup.length === 0;
  await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
  if (error || cleanup.length)
    throw new AggregateError([...(error ? [error] : []), ...cleanup], "Handoff restart failed");
}
