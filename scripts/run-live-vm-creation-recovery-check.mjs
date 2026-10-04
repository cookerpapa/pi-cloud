import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { sql } from "kysely";
import { createDatabase } from "../packages/database/src/index.ts";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { serviceAddress, kubectl, podFor } from "./lib/production-kubernetes.mjs";

if (process.env.PI_CLOUD_LIVE_CREATION_RECOVERY_CHECK !== "1")
  throw Error(
    "Set PI_CLOUD_LIVE_CREATION_RECOVERY_CHECK=1 for owned Luna creation/Control Plane SIGKILL acceptance",
  );
const runtime = "deploy/production/runtime",
  env = await readFile(`${runtime}/.env`, "utf8");
const port = env.match(/^PI_CLOUD_HTTP_PORT=(\d+)$/m)?.[1];
assert(port);
const api = new PiCloudApi(
  (url, init) => fetch(new URL(String(url), `http://127.0.0.1:${port}`), init),
  (await readFile(`${runtime}/secrets/api-token`, "utf8")).trim(),
);
const pg = new URL((await readFile(`${runtime}/secrets/database-url`, "utf8")).trim());
pg.hostname = serviceAddress("postgres");
const database = createDatabase({ connectionString: pg.toString(), maxConnections: 2 });
const report = { checkedAt: new Date().toISOString(), model: "gpt-6-luna", accepted: false };
let project, session, failure;
const turns = [];
const terminal = (r) => ["completed", "failed", "cancelled", "timed_out"].includes(r.state);
async function until(fn, label, timeout = 180000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {}
    await delay(25);
  }
  throw Error(`Timed out: ${label}`);
}
async function run(prompt) {
  const t = await api.acceptTurn(
    session.sessionId,
    prompt,
    newIdempotencyKey("creation-recovery"),
    "low",
  );
  turns.push(t);
  return t;
}
async function settled(turn) {
  return until(async () => {
    const r = await api.getRun(turn.runId);
    return terminal(r) && r;
  }, "Run settlement");
}
try {
  const { rows: foreign } =
    await sql`select count(*)::int n from runs where state not in ('completed','failed','cancelled','timed_out')`.execute(
      database,
    );
  assert.equal(foreign[0].n, 0, "Refuse process fault with unrelated pending/active Runs");
  const { rows: terminals } =
    await sql`select count(*)::int n from workspace_terminal_sessions where state in ('reserved','materializing','active','cleaning')`.execute(
      database,
    );
  assert.equal(terminals[0].n, 0, "Refuse process fault with open terminals");
  project = await api.createProject("VM creation recovery " + Date.now());
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "VM creation recovery",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: report.model, thinkingLevel: "low", fastMode: false },
  );
  const first = await run(
    "只调用一次 bash：printf 'first\n' >> allocation-first.txt。不要重试工具。工具失败则说明失败，然后结束。",
  );
  const allocation = await until(async () => {
    const { rows } =
      await sql`select workspace_runtime_id,creation_not_after,runtime_capsule,allocation_closed from workspace_runtimes
      where workspace_id=${project.workspaceId}::uuid and creation_not_after is not null order by created_at desc limit 1`.execute(
        database,
      );
    return rows[0];
  }, "durable creation authorization");
  assert.equal(
    allocation.runtime_capsule,
    null,
    "Creation completed before the crash window was reached",
  );
  assert.equal(allocation.allocation_closed, false);
  const pod = podFor("control-plane");
  const before = JSON.parse(kubectl(["get", "pod", pod, "-o", "json"]));
  const container =
    before.status.containerStatuses.find((c) => c.name === "control-plane") ??
    before.status.containerStatuses[0];
  const id = container.containerID.replace(/^containerd:\/\//, "");
  assert(/^[a-f0-9]{64}$/.test(id));
  const { rows: guard } =
    await sql`select count(*)::int n from runs where state not in ('completed','failed','cancelled','timed_out') and id<>${first.runId}::uuid`.execute(
      database,
    );
  assert.equal(guard[0].n, 0, "Unrelated work appeared before the fault");
  execFileSync("/usr/local/bin/k3s", [
    "ctr",
    "-n",
    "k8s.io",
    "tasks",
    "kill",
    "--signal",
    "SIGKILL",
    id,
  ]);
  report.uncapsuledAtCrash = true;
  await until(async () => {
    const p = JSON.parse(kubectl(["get", "pod", pod, "-o", "json"]));
    const c = p.status.containerStatuses.find((c) => c.name === container.name);
    return (
      c?.restartCount > container.restartCount &&
      c.lastState?.terminated?.exitCode === 137 &&
      c.ready
    );
  }, "Control Plane restart");
  report.processExit137 = true;
  const restored = await until(async () => {
    const { rows } =
      await sql`select workspace_runtime_id,runtime_id,runtime_capsule,state,allocation_closed,creation_not_after from workspace_runtimes
      where workspace_runtime_id=${allocation.workspace_runtime_id}::uuid`.execute(database);
    const row = rows[0];
    return (
      row?.runtime_capsule &&
      !row.allocation_closed &&
      ["active", "warm"].includes(row.state) &&
      row
    );
  }, "original VM creation adoption");
  assert.equal(
    new Date(restored.creation_not_after).valueOf(),
    new Date(allocation.creation_not_after).valueOf(),
  );
  report.originalAllocationRecovered = true;
  report.creationWindowUnchanged = true;
  const firstResult = await settled(first);
  report.originalRunState = firstResult.state;
  await until(async () => {
    const { rows } =
      await sql`select state from sessions where id=${session.sessionId}::uuid`.execute(database);
    return ["idle", "cold"].includes(rows[0]?.state);
  }, "Session ready for a fresh Run");
  const next = await run(
    "只调用一次 bash：printf 'RECOVERED_ALLOCATION_OK\n'; if [ -f allocation-first.txt ]; then wc -l < allocation-first.txt; else printf '0\n'; fi。不要使用其他工具，然后简短回复。",
  );
  assert.equal((await settled(next)).state, "completed");
  const conversation = await api.getConversation(session.sessionId);
  const tool = conversation.turns
    .find((t) => t.runId === next.runId)
    .transcript.items.find((i) => i.kind === "tool");
  assert.equal(tool.status, "completed");
  assert(JSON.stringify(tool.output).includes("RECOVERED_ALLOCATION_OK"));
  const { rows: allocations } =
    await sql`select count(*)::int n from workspace_runtimes where workspace_id=${project.workspaceId}::uuid`.execute(
      database,
    );
  assert.equal(allocations[0].n, 1, "Recovery replaced or duplicated the physical allocation");
  report.lunaToolAfterRecovery = true;
  report.physicalAllocations = 1;
  report.accepted = true;
} catch (error) {
  failure = error;
} finally {
  const errors = [];
  for (const turn of turns) {
    try {
      if (!terminal(await api.getRun(turn.runId))) {
        await api.cancelTurn(session.sessionId, turn.turnId, newIdempotencyKey("cleanup"));
        await settled(turn);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (session)
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
  report.cleanupCompleted = !errors.length;
  if (failure) report.failure = failure.message;
  await writeFile(
    process.argv[2] ?? "/tmp/pi-cloud-vm-creation-recovery-live.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
  if (failure || errors.length)
    throw new AggregateError(
      [failure, ...errors].filter(Boolean),
      "VM creation recovery acceptance failed",
    );
}
