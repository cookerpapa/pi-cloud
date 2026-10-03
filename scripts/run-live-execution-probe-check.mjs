import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";

if (process.env.PI_CLOUD_LIVE_EXECUTION_PROBE_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_EXECUTION_PROBE_CHECK=1 for GPT-6 Luna and an owned disposable VM",
  );
const runtime = "deploy/production/runtime";
const port = (await readFile(`${runtime}/.env`, "utf8")).match(/^PI_CLOUD_HTTP_PORT=(\d+)$/m)?.[1];
assert(port, "Production port missing");
const token = (await readFile(`${runtime}/secrets/api-token`, "utf8")).trim();
const request = (url, init) => fetch(new URL(String(url), `http://127.0.0.1:${port}`), init);
const api = new PiCloudApi(request, token),
  exec = promisify(execFile);
const terminal = (r) => ["completed", "failed", "cancelled", "timed_out"].includes(r.state);
const report = { checkedAt: new Date().toISOString(), model: "gpt-6-luna", accepted: false };
const controller = new AbortController(),
  observations = [];
let project, session, turn, stream, failure, streamFailure;
async function waitFor(test, label, ms = 180000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (streamFailure) throw streamFailure;
    const value = await test();
    if (value) return value;
    await delay(250);
  }
  throw new Error(`Timed out: ${label}`);
}
async function query(text) {
  const { stdout } = await exec(process.execPath, [
    "scripts/production-kubernetes.mjs",
    "exec",
    "postgres",
    "psql",
    "-U",
    "pi_cloud",
    "-d",
    "pi_cloud",
    "-Atc",
    text,
  ]);
  return stdout.trim();
}
async function controlProbe(workspaceId) {
  assert(/^[0-9a-f-]{36}$/.test(workspaceId));
  const source = `
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createDatabase} from '@pi-cloud/database';
import {loadSandboxControlConfig,OfficialCubeSandboxRuntimeClient} from '@pi-cloud/sandbox-control';
import {CubePersistentCapsuleCodec} from '/app/packages/sandbox-control/src/cube-persistent-capsule.ts';
const config=await loadSandboxControlConfig(),cube=config.cubeSandbox;
const database=createDatabase({connectionString:config.databaseUrl,maxConnections:1});
const client=new OfficialCubeSandboxRuntimeClient({...cube,egressProxyIp:cube.egressProxyHost});
let paused=false,target;
try{
 const row=await database.selectFrom('workspace_runtimes').select('runtime_capsule').where('workspace_id','=',process.argv[2]).where('state','in',['warm','active']).executeTakeFirstOrThrow();
 target=new CubePersistentCapsuleCodec(config.persistentStateKey).open(row.runtime_capsule).executionTarget;
 const start=performance.now();const initial=await client.probeExecution(target,randomUUID());
 assert.equal(initial.type,'worker.probe_result');
 const directMs=performance.now()-start;
 await assert.rejects(client.probeExecution({...target,bootId:randomUUID()},randomUUID()),e=>e.code==='executor_replaced');
 // An undeliverable reply belongs solely to this fixture. Do not interrupt
 // the shared Kafka brokers or a user's Worker to emulate that failure.
 const probeId=randomUUID(),bindingId=randomUUID();
 await client.submitProbe(target,{probeId,runId:randomUUID(),writerId:randomUUID(),completionContext:{
   kind:'execution_probe',replyTopic:'pi-cloud.tool-replies.v1.'+randomUUID(),sentAt:Date.now(),bindingIds:[bindingId],
   execution:{bindingId,targetId:'fixture',bootId:target.bootId}}});
 await client.probeExecution(target,randomUUID());
 await client.pause(target.sandboxId);paused=true;
 await assert.rejects(client.probeExecution(target,randomUUID()));
 assert.equal((await client.observe(target.sandboxId,target.nodeId)).state,'paused');
 await client.connect(target.sandboxId,-1);paused=false;
 await client.probeExecution(target,randomUUID());
 console.log(JSON.stringify({directMs,oldBootRejected:true,directWithUndeliverableReply:true,pausedNotWoken:true,resumed:true}));
}finally{
 if(paused&&target)await client.connect(target.sandboxId,-1).catch(()=>{});
 await client.close();await database.destroy();
}
`;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "scripts/production-kubernetes.mjs",
        "exec",
        "control-plane",
        "node",
        "--import",
        "tsx",
        "--input-type=module",
        "-",
        workspaceId,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let output = "",
      diagnostic = "";
    child.stdout.on("data", (data) => {
      output = (output + data.toString()).slice(-65536);
    });
    child.stderr.on("data", (data) => {
      diagnostic = (diagnostic + data.toString()).slice(-16384);
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`Owned runtime probe failed: ${diagnostic}`));
        return;
      }
      try {
        resolve(JSON.parse(output.trim().split("\n").at(-1)));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(source);
  });
}
try {
  project = await api.createProject(`Execution probe acceptance ${Date.now()}`);
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Execution probe acceptance",
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: report.model, thinkingLevel: "low", fastMode: false },
  );
  report.sessionId = session.sessionId;
  stream = streamSessionEvents({
    sessionId: session.sessionId,
    signal: controller.signal,
    authorizationToken: token,
    fetchImplementation: request,
    onSnapshot() {},
    onEvent() {},
    onStatus() {},
    onRunObservation(value) {
      if (observations.length < 256) observations.push(value);
    },
  }).catch((error) => {
    if (!controller.signal.aborted) streamFailure = error;
  });
  turn = await api.acceptTurn(
    session.sessionId,
    "只回复 CHAT_ONLY_OK，不要调用任何工具。",
    newIdempotencyKey("probe-chat"),
    "low",
  );
  const chat = await waitFor(async () => {
    const r = await api.getRun(turn.runId);
    return terminal(r) ? r : undefined;
  }, "chat-only completion");
  assert.equal(chat.state, "completed", JSON.stringify(chat.failure));
  assert.equal(
    await query(
      `select count(*) from workspace_runtimes where workspace_id='${project.workspaceId}'`,
    ),
    "0",
  );
  report.chatAllocatedNoVm = true;
  turn = await api.acceptTurn(
    session.sessionId,
    "只调用一次 bash，命令必须为：sleep 40; printf 'EXECUTION_PROBE_OK'。不要调用其他工具、不要搜索、不要子代理。完成后只回复 EXECUTION_PROBE_OK。",
    newIdempotencyKey("probe-bash"),
    "low",
  );
  report.runId = turn.runId;
  await waitFor(async () => {
    const r = await api.getRun(turn.runId);
    if (terminal(r)) {
      report.runFailure = r.failure;
      throw new Error(
        `Run ended before live probe confirmation: ${r.state} ${JSON.stringify(r.failure)}`,
      );
    }
    const confirmed = observations.find(
      (v) => v.runId === turn.runId && v.type === "run.execution" && v.execution.confirmedAt,
    );
    if (!confirmed) return;
    const detail = await api.getConversation(session.sessionId);
    const tools =
      detail.turns
        .find((t) => t.runId === turn.runId)
        ?.transcript.items.filter((i) => i.kind === "tool") ?? [];
    if (tools.some((t) => t.status === "running")) return confirmed;
  }, "probe returned while the real Bash remains in progress");
  report.confirmedDuringBash = true;
  assert(observations.some((v) => v.runId === turn.runId && v.type === "run.path"));
  const done = await waitFor(async () => {
    const r = await api.getRun(turn.runId);
    return terminal(r) ? r : undefined;
  }, "Bash completion");
  assert.equal(done.state, "completed", JSON.stringify(done.failure));
  const detail = await api.getConversation(session.sessionId),
    transcript = detail.turns.find((t) => t.runId === turn.runId).transcript;
  const tools = transcript.items.filter((i) => i.kind === "tool");
  assert.equal(tools.length, 1);
  assert.equal(tools[0].status, "completed");
  report.stages = [
    ...new Set(
      observations
        .filter((v) => v.runId === turn.runId && v.type === "run.execution")
        .map((v) => v.execution.stage),
    ),
  ];
  report.observationFrames = observations.length;
  assert.equal(
    await query(
      `select count(*) from pi_session_log where session_id=(select pi_session_id from sessions where id='${session.sessionId}') and jsonb_path_exists(payload,'$.** ? (@.kind == "path_probe" || @.type == "worker.probe_result" || @.type == "run.execution")')`,
    ),
    "0",
  );
  report.noProbeHistory = true;
  report.runtime = await controlProbe(project.workspaceId);
  report.accepted = true;
} catch (error) {
  failure = error;
} finally {
  controller.abort();
  await stream?.catch(() => {});
  const cleanup = [];
  if (turn && session)
    try {
      if (!terminal(await api.getRun(turn.runId))) {
        await api.cancelTurn(session.sessionId, turn.turnId, newIdempotencyKey("probe-cancel"));
        await waitFor(async () => terminal(await api.getRun(turn.runId)), "cancel cleanup");
      }
    } catch (error) {
      cleanup.push(error);
    }
  if (session)
    try {
      await api.deleteConversation(session.sessionId);
    } catch (error) {
      cleanup.push(error);
    }
  if (project)
    try {
      await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("probe-clean-workspace"));
    } catch (error) {
      cleanup.push(error);
    }
  report.cleanupCompleted = cleanup.length === 0;
  await writeFile(
    process.argv[2] ?? "/tmp/pi-cloud-execution-probe-live.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
  if (failure || cleanup.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...cleanup],
      "Execution probe acceptance failed",
    );
}
