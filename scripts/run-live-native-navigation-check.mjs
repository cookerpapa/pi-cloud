// Real Luna/Cube acceptance of indexed navigation and independent native Fork copies.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { execIn, runtimeEnvironment } from "./lib/production-kubernetes.mjs";
if (process.env.PI_CLOUD_LIVE_NAVIGATION_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_NAVIGATION_CHECK=1 for Luna tokens and a disposable Workspace",
  );
const environment = runtimeEnvironment();
const api = new PiCloudApi(
  (url, init) =>
    fetch(new URL(String(url), `http://127.0.0.1:${environment.PI_CLOUD_HTTP_PORT}`), init),
  (await readFile("deploy/production/runtime/secrets/api-token", "utf8")).trim(),
);
const report = {
  checkedAt: new Date().toISOString(),
  model: "gpt-6-luna",
  accepted: false,
  runs: [],
};
const sessions = [],
  active = [];
let project, failure;
const terminal = (r) => ["completed", "cancelled", "failed", "timed_out"].includes(r.state);
async function waitRun(id) {
  const end = Date.now() + 300000;
  while (Date.now() < end) {
    const r = await api.getRun(id);
    if (terminal(r)) return r;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw Error("Navigation acceptance Run timed out");
}
async function turn(sessionId, prompt) {
  const a = await api.acceptTurn(sessionId, prompt, newIdempotencyKey("navigation"), "low");
  active.push({ sessionId, ...a });
  const r = await waitRun(a.runId);
  assert.equal(r.state, "completed", JSON.stringify(r.failure));
  const t = (await api.getConversation(sessionId)).turns.find((v) => v.turnId === a.turnId);
  report.runs.push({ runId: a.runId, state: r.state });
  return { accepted: a, turn: t };
}
try {
  project = await api.createProject(`Native navigation acceptance ${Date.now()}`, {
    kind: "empty",
  });
  const s = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Native navigation",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: "gpt-6-luna", thinkingLevel: "low", fastMode: false },
  );
  sessions.push(s.sessionId);
  const first = await turn(
    s.sessionId,
    `Call bash once with exactly this command, then reply only NAVIGATION-READY. Do not use any other tools.\npython3 - <<'PY'\nimport random\nn = random.randint(70, 110)\nprint("NAVIGATION_CHECKSUM=" + str(sum(range(n))))\nprint("context-payload-" * 2000)\nPY`,
  );
  const tools = first.turn.transcript.items.filter((v) => v.kind === "tool");
  assert.equal(tools.length, 1);
  assert.equal(tools[0].toolName, "bash");
  assert.equal(tools[0].status, "completed", JSON.stringify(tools[0].output).slice(0, 1500));
  const checksum = JSON.stringify(tools[0].output).match(/NAVIGATION_CHECKSUM=([0-9]+)/)?.[1];
  assert(checksum, "Computed checksum is absent from the Tool output");
  const tree = await api.getConversationTree(s.sessionId, "full");
  const focused = await api.getConversationTree(s.sessionId, "focus");
  assert.equal(focused.branches.length, 1);
  const branch = tree.branches.find((v) => v.sessionId === s.sessionId);
  const anchor = branch.entries.find((v) => v.turnId === first.accepted.turnId && v.finalAssistant);
  assert(anchor, "Indexed navigation omitted the assistant anchor");
  const fork = await api.forkConversation(
    s.sessionId,
    first.accepted.turnId,
    anchor.entryId,
    "Native navigation fork",
    newIdempotencyKey("navigation-fork"),
  );
  sessions.push(fork.session.sessionId);
  const historyCheck = JSON.parse(
    execIn("control-plane", [
      "node",
      "--input-type=module",
      "-e",
      `import pg from 'pg';import{readFileSync}from'node:fs';
       const db=new pg.Client({connectionString:readFileSync(process.env.DATABASE_URL_FILE,'utf8').trim()});
       await db.connect();try{const result=[];for(const sessionId of ${JSON.stringify([s.sessionId, fork.session.sessionId])}){
       const {rows}=await db.query('select body from pi_durable_log where session_id=$1 and record_kind=$2',[sessionId,'entry']);
       const messages=rows.flatMap(r=>JSON.parse(r.body).value?.model??[]);
       const tools=messages.filter(m=>m.role==='toolResult'&&JSON.stringify(m).includes(${JSON.stringify("NAVIGATION_CHECKSUM=" + checksum)}));
       result.push({toolResults:tools.length,sha256:(await import('node:crypto')).createHash('sha256').update(JSON.stringify(tools)).digest('hex')});}
       console.log(JSON.stringify(result));}finally{await db.end();}`,
    ]),
  );
  assert(historyCheck[0].toolResults > 0, "Source has no canonical Tool checksum");
  assert.deepEqual(historyCheck[1], historyCheck[0], "Fork changed canonical Tool results");
  report.nativeToolCopy = historyCheck[0];
  const recovered = await turn(
    fork.session.sessionId,
    "Using only the earlier bash result in this conversation, reply with the numeric test checksum after NAVIGATION_CHECKSUM=. Do not call tools.",
  );
  const items = recovered.turn.transcript.items;
  assert.equal(items.filter((v) => v.kind === "tool").length, 0);
  assert(
    items
      .filter((v) => v.kind === "text")
      .map((v) => v.text)
      .join("")
      .includes(checksum),
    `Luna did not recall the copied Tool checksum: ${items
      .filter((v) => v.kind === "text")
      .map((v) => v.text)
      .join("")
      .slice(0, 200)}`,
  );
  await turn(s.sessionId, "Do not call tools. Reply only NAVIGATION-LATER.");
  const pruned = await api.pruneConversation(
    s.sessionId,
    first.accepted.turnId,
    anchor.entryId,
    newIdempotencyKey("navigation-prune"),
  );
  assert(pruned.prunedTurnCount >= 1);
  assert.equal((await api.getConversation(s.sessionId)).turns.length, 1);
  assert.equal(pruned.prunedSessionCount, 1);
  await assert.rejects(
    api.getConversation(fork.session.sessionId),
    (error) => error.status === 404 && error.code === "not_found",
  );
  Object.assign(report, {
    accepted: true,
    navigationAnchor: true,
    independentFork: true,
    toolContextRetained: true,
    pruneRetiresDescendant: true,
  });
} catch (error) {
  failure = error;
} finally {
  const errors = [];
  for (const a of active) {
    try {
      if (!terminal(await api.getRun(a.runId))) {
        await api.cancelTurn(a.sessionId, a.turnId, newIdempotencyKey("navigation-cancel"));
        await waitRun(a.runId);
      }
    } catch (e) {
      errors.push(e);
    }
  }
  for (const id of sessions.reverse()) {
    try {
      await api.deleteConversation(id);
    } catch (e) {
      errors.push(e);
    }
  }
  if (project) {
    try {
      await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("navigation-delete"));
    } catch (e) {
      errors.push(e);
    }
  }
  report.cleanupRequested = errors.length === 0;
  await writeFile(
    process.argv[2] ?? "docs/reports/review-release-navigation-20261006.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
  if (failure || errors.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      "Native navigation acceptance failed",
    );
}
