import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { createDatabase } from "../packages/database/src/index.ts";
import { sql } from "kysely";
import { serviceAddress } from "./lib/production-kubernetes.mjs";

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
let project, failure;
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
  const command = `printf 'started\\n' >> ${prefix}.count; printf '%s' $$ > ${prefix}.parent; sleep 120 & child=$!; printf '%s' "$child" > ${prefix}.child; wait "$child"; printf 'late\\n' > ${prefix}.late`;
  const cancelled = await run(
    first,
    `只调用一次 bash，command 必须逐字使用这个 JSON 字符串：${JSON.stringify(command)}，timeout 为 180。不要使用其他工具。执行完简短回复。`,
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
  const cancellationAt = Date.now();
  await api.cancelTurn(first.sessionId, cancelled.turnId, newIdempotencyKey("cancel-owned-scope"));
  const cancelledRun = await settled(cancelled);
  assert.equal(cancelledRun.state, "cancelled", JSON.stringify(cancelledRun.failure));
  report.cancelMs = Date.now() - cancellationAt;
  assert(report.cancelMs < 15000, "Agent Stop waited for the running command");
  // The next Agent invocation must see both processes still alive; only its
  // explicit Bash command then terminates these owned fixture processes.
  const verify = `for f in ${prefix}.parent ${prefix}.child; do pid=$(cat "$f"); state=$(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null || true); case "$state" in ""|Z) printf 'PROCESS_DIED_ON_CHAT_STOP'; exit 1;; esac; done; printf 'SURVIVED_CHAT_STOP\\n'; kill "$(cat ${prefix}.child)" "$(cat ${prefix}.parent)"; printf 'EXPLICIT_PROCESS_STOP'`;
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
  assert(JSON.stringify(tools[0].output).includes("SURVIVED_CHAT_STOP"));
  assert(JSON.stringify(tools[0].output).includes("EXPLICIT_PROCESS_STOP"));
  report.parentAndChildSurvivedChatStop = true;
  report.explicitProcessStopInNextRun = true;
  const survived = await settled(peer);
  assert.equal(survived.state, "completed", JSON.stringify(survived.failure));
  assert.equal(await read(sibling, `${prefix}.sibling`), "ready\nsurvived\n");
  assert.equal(await read(first, `${prefix}.count`), "started\n");
  const cancelledDetail = (await api.getConversation(first.sessionId)).turns.find(
    (t) => t.runId === cancelled.runId,
  );
  assert(JSON.stringify(cancelledDetail).includes("may still be running"));
  report.interruptionContextRetained = true;
  report.siblingCompleted = true;
  report.executionCount = 1;
  report.accepted = true;
} catch (error) {
  failure = error;
} finally {
  const errors = [];
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
      "Agent Stop survival acceptance failed",
    );
}
