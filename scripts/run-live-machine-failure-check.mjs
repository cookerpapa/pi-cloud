import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import WebSocket from "ws";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { readPreviewDocument } from "./lib/preview-client.mjs";

if (process.env.PI_CLOUD_LIVE_MACHINE_FAILURE_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_MACHINE_FAILURE_CHECK=1 to permit a disposable Cube, real models and a Tool Broker restart",
  );
const exec = promisify(execFile);
const env = Object.fromEntries(
  (await readFile("deploy/production/runtime/.env", "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
const token = (await readFile("deploy/production/runtime/secrets/api-token", "utf8")).trim();
const db = new URL(
  (await readFile("deploy/production/runtime/secrets/database-url", "utf8")).trim(),
);
const base = `http://127.0.0.1:${env.PI_CLOUD_HTTP_PORT}`;
const api = new PiCloudApi((path, init) => fetch(new URL(path, base), init), token);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sqlString = (value) => `'${String(value).replaceAll("'", "''")}'`;
async function compose(...args) {
  const result = await exec(process.execPath, ["scripts/production-compose.mjs", ...args], {
    timeout: 180000,
    maxBuffer: 256 * 1024,
  });
  return result.stdout.trim();
}
async function sql(query) {
  return compose(
    "exec",
    "-T",
    "postgres",
    "psql",
    "-X",
    "-U",
    decodeURIComponent(db.username),
    "-d",
    decodeURIComponent(db.pathname.slice(1)),
    "-At",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    query,
  );
}
let machine, session;
const report = {
  checkedAt: new Date().toISOString(),
  runs: [],
  accepted: false,
  hostPowerLossTested: false,
};
const suffix = Date.now().toString(36);
async function waitForMachine() {
  for (let n = 0; n < 480; n++) {
    const current = (await api.listDevelopmentEnvironments()).environments.find(
      (item) => item.environmentId === machine.environmentId,
    );
    if (current?.state === "running") return;
    if (current?.state === "failed") throw new Error(`Machine failed: ${current.failureCode}`);
    await sleep(500);
  }
  throw new Error("Machine did not become runnable");
}
async function terminal(command) {
  const socket = new WebSocket(
    base.replace("http", "ws") + `/v1/development-environments/${machine.environmentId}/terminal`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const marker = `MACHINE_CHECK_OK_${Date.now()}`;
  const script = Buffer.from(`set -e\n${command}\nprintf '\\n${marker}\\n'\n`).toString("base64");
  return new Promise((resolve, reject) => {
    let output = "",
      closing = false;
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error(`Terminal timed out: ${output.slice(-1000)}`));
    }, 45000);
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === "workspace_terminal.ready")
        socket.send(
          JSON.stringify({
            workspaceTerminalProtocolVersion: 1,
            type: "workspace_terminal.input",
            data: Buffer.from(`printf '%s' '${script}' | base64 -d | bash\n`).toString("base64"),
          }),
        );
      if (frame.type === "workspace_terminal.output") {
        output += Buffer.from(frame.data, "base64").toString();
        if (!closing && output.includes(marker)) {
          closing = true;
          socket.send(
            JSON.stringify({
              workspaceTerminalProtocolVersion: 1,
              type: "workspace_terminal.close",
            }),
          );
        }
      }
      if (frame.type === "workspace_terminal.error") {
        clearTimeout(timer);
        socket.terminate();
        reject(new Error(`${frame.code}: ${frame.message}`));
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.once("close", () => {
      clearTimeout(timer);
      closing ? resolve(output) : reject(new Error("Terminal closed without command success"));
    });
  });
}
async function preview() {
  const response = await fetch(
    `${base}/v1/development-environments/${machine.environmentId}/preview/5173/`,
    { headers: { authorization: `Bearer ${token}` }, redirect: "manual" },
  );
  assert.equal(response.status, 307);
  const url = response.headers.get("location");
  await response.body?.cancel();
  return readPreviewDocument(url, "127.0.0.1");
}
async function run(prompt) {
  const start = Date.now();
  const accepted = await api.acceptTurn(
    session.sessionId,
    prompt,
    newIdempotencyKey("machine-failure-turn"),
    "off",
  );
  report.runs.push({ runId: accepted.runId });
  for (let n = 0; n < 1200; n++) {
    const state = await api.getRun(accepted.runId);
    if (state.state === "completed") {
      report.runs.at(-1).elapsedMs = Date.now() - start;
      return;
    }
    if (["failed", "cancelled", "timed_out", "superseded"].includes(state.state))
      throw new Error(`Run failed: ${JSON.stringify(state.failure)}`);
    await sleep(250);
  }
  throw new Error("Real model Run timed out");
}
try {
  machine = await api.createDevelopmentEnvironment(
    `Failure boundary acceptance ${suffix}`,
    "starter",
    newIdempotencyKey("machine"),
  );
  await waitForMachine();
  report.environmentId = machine.environmentId;
  const identity = await sql(
    `select runtime_id::text from development_environments where id=${sqlString(machine.environmentId)}`,
  );
  console.log("[machine-failure] disposable machine ready; testing terminal and public preview");
  await terminal(
    "mkdir -p /home/user/recovery-check; printf 'ROOT_SURVIVES\\n' > /etc/pi-cloud-recovery-check; printf '<!doctype html><title>Recovery check</title><button id=counter onclick=\"this.textContent=Number(this.textContent)+1\">0</button>APP_READY' > /home/user/recovery-check/index.html; nohup python3 -m http.server 5173 --bind 0.0.0.0 --directory /home/user/recovery-check </dev/null >/tmp/pi-cloud-recovery-http.log 2>&1 & echo $! > /tmp/pi-cloud-recovery-http.pid; sleep 1; kill -0 \"$(cat /tmp/pi-cloud-recovery-http.pid)\"",
  );
  assert.equal((await preview()).status, 200);
  // SSH runs as guest root; Agent Tools run as uid 1000. Avoid turning the
  // fixture into an unrelated ownership repair task (and root-owned residue).
  await terminal("chown -R 1000:1000 /home/user/recovery-check");
  await terminal('kill "$(cat /tmp/pi-cloud-recovery-http.pid)"; sleep 1');
  const stopped = await preview();
  assert.equal(stopped.status, 502);
  assert.match(stopped.body.toString(), /application port/);
  await terminal(
    "test -f /etc/pi-cloud-recovery-check; test -f /home/user/recovery-check/index.html",
  );
  assert.equal(
    await sql(
      `select runtime_id::text from development_environments where id=${sqlString(machine.environmentId)}`,
    ),
    identity,
  );
  report.stoppedApplicationDidNotStopMachine = true;
  await terminal(
    'nohup python3 -m http.server 5173 --bind 0.0.0.0 --directory /home/user/recovery-check </dev/null >/tmp/pi-cloud-recovery-http.log 2>&1 & echo $! > /tmp/pi-cloud-recovery-http.pid; sleep 1; kill -0 "$(cat /tmp/pi-cloud-recovery-http.pid)"',
  );
  assert.equal((await preview()).status, 200);
  report.applicationRestarted = true;
  session = await api.createSession(
    machine.projectId,
    machine.workspaceId,
    `Recovery coding ${suffix}`,
    "development_environment",
    "starter",
    "/home/user/recovery-check",
    { provider: "deepseek", modelId: "deepseek-v4-flash", thinkingLevel: "off", fastMode: false },
  );
  console.log("[machine-failure] real DeepSeek coding round 1");
  await run(
    "在当前目录编写 insertion_sort.py，实现插入排序并自带空数组、重复值、负数、逆序测试。运行 python3 insertion_sort.py，确认通过。保留已有 index.html 和 HTTP 服务，不使用子代理或搜索。",
  );
  await terminal(
    'test -s /home/user/recovery-check/insertion_sort.py; cd /home/user/recovery-check; python3 insertion_sort.py; kill -0 "$(cat /tmp/pi-cloud-recovery-http.pid)"',
  );
  const active = Number(await sql("select count(*) from runs where state = 'running'"));
  assert.equal(active, 0, "Refusing Broker restart while any user Run is active");
  console.log(
    "[machine-failure] restarting only Tool Broker; Guest and application must stay alive",
  );
  await compose("restart", "tool-broker");
  for (let n = 0; n < 120; n++) {
    try {
      await compose(
        "exec",
        "-T",
        "tool-broker",
        "node",
        "-e",
        "fetch('http://127.0.0.1:4300/health/ready').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
      );
      break;
    } catch {
      if (n === 119) throw new Error("Broker did not restart");
      await sleep(500);
    }
  }
  await waitForMachine();
  await terminal(
    'test "$(cat /etc/pi-cloud-recovery-check)" = ROOT_SURVIVES; test -s /home/user/recovery-check/insertion_sort.py; kill -0 "$(cat /tmp/pi-cloud-recovery-http.pid)"',
  );
  assert.equal((await preview()).status, 200);
  assert.equal(
    await sql(
      `select runtime_id::text from development_environments where id=${sqlString(machine.environmentId)}`,
    ),
    identity,
  );
  report.brokerRestartPreservedRootFilesProcessAndPreview = true;
  console.log("[machine-failure] real DeepSeek coding round 2 after Broker replacement");
  await run(
    "先读取 insertion_sort.py，保留原实现和测试。新增 binary_search.py，实现二分查找并覆盖命中、不存在、空数组、重复值。执行 python3 insertion_sort.py && python3 binary_search.py。不要修改 index.html 或 HTTP 服务，不使用子代理或搜索。",
  );
  await terminal(
    'cd /home/user/recovery-check; python3 insertion_sort.py; python3 binary_search.py; kill -0 "$(cat /tmp/pi-cloud-recovery-http.pid)"',
  );
  report.resetMarkers = Number(
    await sql(
      `select count(*) from pi_session_entries where session_id=${sqlString(session.sessionId)} and custom_type='pi-cloud.sandbox_reset'`,
    ),
  );
  assert.equal(report.resetMarkers, 0);
  report.usage = JSON.parse(
    await sql(
      `select json_build_object('input',coalesce(sum((payload->'message'->'usage'->>'input')::bigint),0),'output',coalesce(sum((payload->'message'->'usage'->>'output')::bigint),0),'cacheRead',coalesce(sum((payload->'message'->'usage'->>'cacheRead')::bigint),0)) from pi_session_entries where session_id=${sqlString(session.sessionId)}`,
    ),
  );
  report.accepted = true;
} catch (error) {
  report.failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  // Delete only resources allocated above, never the user's existing machine.
  const cleanupErrors = [];
  if (session)
    await api
      .deleteConversation(session.sessionId, newIdempotencyKey("delete-machine-check-session"))
      .catch((error) => cleanupErrors.push(error.message));
  if (machine)
    await api
      .developmentEnvironmentAction(
        machine.environmentId,
        "release",
        newIdempotencyKey("release-machine-check"),
      )
      .catch((error) => cleanupErrors.push(error.message));
  report.resourcesReleased = cleanupErrors.length === 0;
  if (cleanupErrors.length) report.cleanupErrors = cleanupErrors;
  await writeFile(
    "docs/reports/machine-failure-acceptance-latest.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
}
