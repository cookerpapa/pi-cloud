import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { execIn, runtimeEnvironment } from "./lib/production-kubernetes.mjs";

if (process.env.PI_CLOUD_LIVE_COMPLETE_TOOL_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_COMPLETE_TOOL_CHECK=1 for Luna tokens and a disposable Workspace",
  );
const environment = runtimeEnvironment();
const token = (await readFile("deploy/production/runtime/secrets/api-token", "utf8")).trim();
const api = new PiCloudApi(
  (input, init) =>
    fetch(new URL(String(input), `http://127.0.0.1:${environment.PI_CLOUD_HTTP_PORT}`), init),
  token,
);
const content =
  "Tool arguments become durable only after the model response completes.\n" +
  "Text streaming stays visible before that point.\n";
const digest = createHash("sha256").update(content).digest("hex");
const report = { checkedAt: new Date().toISOString(), model: "gpt-6-luna", accepted: false };
let project, session, turn, failure;
const terminal = (run) => ["completed", "failed", "cancelled", "timed_out"].includes(run.state);
async function waitRun(runId, timeout = 300000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const run = await api.getRun(runId);
    if (terminal(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error("Complete Tool publication probe timed out");
}
try {
  project = await api.createProject(`Complete Tool publication ${Date.now()}`);
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Complete Tool publication",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: report.model, thinkingLevel: "low", fastMode: false },
  );
  turn = await api.acceptTurn(
    session.sessionId,
    `请严格按顺序执行：先调用 write，在 complete-tool-call.txt 写入这个 JSON 字符串的内容，保持字节和末尾换行不变：${JSON.stringify(content)}。然后调用 bash 执行 sha256sum complete-tool-call.txt。最后简短报告。不要搜索、读取其他文件或委派。`,
    newIdempotencyKey("complete-tool-publication"),
    "low",
  );
  const run = await waitRun(turn.runId);
  assert.equal(run.state, "completed", "Live Tool probe did not complete");
  const conversation = await api.getConversation(session.sessionId);
  const saved = conversation.turns.find((entry) => entry.runId === turn.runId);
  const tools = saved.transcript.items.filter((item) => item.kind === "tool");
  assert(tools.some((tool) => tool.toolName === "write" && tool.status === "completed"));
  assert(
    tools.some((tool) => tool.toolName === "bash" && JSON.stringify(tool.output).includes(digest)),
  );
  // Only aggregate metadata leaves the Pod. Native bodies and credentials are
  // inspected there and never written into the acceptance report.
  const code = `
    import pg from 'pg'; import {readFileSync} from 'node:fs';
    const db=new pg.Client({connectionString:readFileSync(process.env.DATABASE_URL_FILE,'utf8').trim()});
    await db.connect();
    try {
      const {rows}=await db.query('select l.record_kind,l.body from pi_durable_log l join sessions s on s.tenant_id=l.tenant_id and s.pi_session_id=l.session_id where s.id=$1 order by l.seq,l.ordinal',[${JSON.stringify(session.sessionId)}]);
      const count=(v)=>v&&typeof v==='object'?(v.type==='toolCall'?1:0)+Object.values(v).reduce((n,x)=>n+count(x),0):0;
      const metrics={nativeWrites:rows.length,documentWrites:0,toolCallsInDocuments:0,completeToolCalls:0,executeCheckpoints:0};
      for(const row of rows){const w=JSON.parse(row.body);
        if(row.record_kind.startsWith('document.')){metrics.documentWrites++;metrics.toolCallsInDocuments+=count(w);}
        if(w.type==='entry')metrics.completeToolCalls+=count(w.value.model);
        if(w.type==='task'&&w.value.kind==='pi.tool'&&w.value.state.checkpoint?.phase==='execute')metrics.executeCheckpoints++;
      }
      console.log(JSON.stringify(metrics));
    } finally {await db.end();}
  `;
  const metrics = JSON.parse(execIn("control-plane", ["node", "--input-type=module", "-e", code]));
  assert(metrics.documentWrites > 0, "Probe inspected no native documents");
  assert.equal(metrics.toolCallsInDocuments, 0, "Tool draft reached a native document");
  assert(metrics.completeToolCalls >= 2 && metrics.executeCheckpoints >= 2);
  report.metrics = metrics;
  report.toolNames = tools.map((tool) => tool.toolName);
  report.exactFileBytesVerified = true;
  report.accepted = true;
} catch (error) {
  failure = error;
} finally {
  const errors = [];
  if (turn && session) {
    try {
      if (!terminal(await api.getRun(turn.runId))) {
        await api.cancelTurn(
          session.sessionId,
          turn.turnId,
          newIdempotencyKey("complete-tool-clean"),
        );
        await waitRun(turn.runId, 120000);
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (session) {
    try {
      await api.deleteConversation(session.sessionId);
    } catch (error) {
      errors.push(error);
    }
  }
  if (project) {
    try {
      await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("complete-tool-workspace"));
    } catch (error) {
      errors.push(error);
    }
  }
  report.cleanupAccepted = errors.length === 0;
  await writeFile(
    process.env.PI_CLOUD_COMPLETE_TOOL_REPORT ??
      "docs/reports/complete-tool-call-live-20261006.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
  if (failure || errors.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...errors],
      "Complete Tool publication probe failed",
    );
}
