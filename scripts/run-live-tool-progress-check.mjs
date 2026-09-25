import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";
import { withChromePage } from "./lib/chrome-cdp.mjs";
import { readWorkerModelTimings } from "./lib/live-run-timing.mjs";

if (process.env.PI_CLOUD_LIVE_TOOL_PROGRESS_CHECK !== "1")
  throw new Error("Opt in with PI_CLOUD_LIVE_TOOL_PROGRESS_CHECK=1 (Luna tokens, Cube, browser)");
const port = (await readFile("deploy/production/runtime/.env", "utf8")).match(
  /^PI_CLOUD_HTTP_PORT=(\d+)$/m,
)?.[1];
assert(port);
const base = `http://127.0.0.1:${port}`,
  suffix = Date.now().toString(36);
const username = `progress.${suffix}`,
  password = `Progress ${suffix} !9`,
  title = `Progress ${suffix}`;
let cookie = "",
  project,
  session,
  active,
  stream;
let snapshots = 0;
const abort = new AbortController();
const apiFetch = async (path, init = {}) => {
  const response = await fetch(new URL(path, base), {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), ...(cookie ? { cookie } : {}) },
  });
  for (const value of response.headers.getSetCookie())
    if (value.startsWith("pi_cloud_session=")) cookie = value.split(";")[0];
  return response;
};
const api = new PiCloudApi(apiFetch),
  exec = promisify(execFile);
const updates = [],
  events = [],
  report = {
    checkedAt: new Date().toISOString(),
    model: "gpt-5.6-luna",
    accepted: false,
    runs: [],
  };
const terminal = (run) => ["completed", "failed", "cancelled", "timed_out"].includes(run.state);
async function waitRun(id, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const run = await api.getRun(id);
    if (terminal(run)) return run;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("Run did not settle");
}
try {
  await api.registerAccount(username, title, password);
  const identity = await api.getIdentity();
  project = await api.createProject(title);
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    title,
    "elastic",
    "starter",
    "/workspace",
    { provider: "openai-codex", modelId: report.model, thinkingLevel: "low", fastMode: false },
  );
  // IDs retained privately for exact, owned metadata cleanup; not transcripts or credentials.
  await writeFile(
    ".cache/tool-progress-resources.json",
    JSON.stringify({
      username,
      tenantId: identity.tenantId,
      userId: identity.userId,
      projectId: project.projectId,
      workspaceId: project.workspaceId,
      sessionId: session.sessionId,
    }),
    { mode: 0o600 },
  );
  stream = streamSessionEvents({
    sessionId: session.sessionId,
    signal: abort.signal,
    fetchImplementation: apiFetch,
    onSnapshot() {
      snapshots++;
    },
    onStatus() {},
    onEvent(event) {
      events.push(event);
    },
    onToolProgress(progress) {
      updates.push({ ...progress, receivedAt: Date.now() });
    },
  });
  void stream.catch(() => {});
  await withChromePage({ height: 600 }, async (page) => {
    await page.navigate(base);
    assert.equal(
      await page.evaluate(
        `fetch('/v1/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(${JSON.stringify({ username, password })})}).then(r=>r.status)`,
      ),
      200,
    );
    const select = async () => {
      await page.navigate(base);
      await page.waitFor(
        `Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes(${JSON.stringify(title)}))`,
      );
      await page.evaluate(
        `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes(${JSON.stringify(title)})).click()`,
      );
    };
    await select();
    const started = Date.now();
    active = await api.acceptTurn(
      session.sessionId,
      '只执行一次 bash 工具，逐字使用以下命令，不要后台运行、不要重定向、不要子代理：python3 -u -c \'import time; print("x"*1500000); [(print("OBS_TICK_"+str(i), flush=True), time.sleep(1)) for i in range(50)]; print("OBS_DONE")\'。完成后简短确认。',
      newIdempotencyKey("live-progress"),
      "low",
    );
    await page.waitFor("document.querySelector('.product-tool-progress button')", 60000);
    assert.equal(
      await page.evaluate(
        "document.querySelector('.product-tool-progress button').getAttribute('aria-expanded')",
      ),
      "false",
    );
    assert.equal(
      await page.evaluate("document.querySelector('.product-tool-progress-tail')===null"),
      true,
    );
    await page.evaluate("document.querySelector('.product-tool-progress button').click()");
    await page.waitFor(
      "document.querySelector('.product-tool-progress-tail')?.textContent.includes('OBS_TICK_')",
      20000,
    );
    const firstText = await page.evaluate(
      "document.querySelector('.product-tool-progress-tail').textContent",
    );
    assert(firstText.length <= 8192);
    await page.evaluate(
      "window.__progressScroll=document.querySelector('.product-tool-progress-tail').getBoundingClientRect().height",
    );
    await page.evaluate(
      "const area=document.querySelector('.product-chat-scroll');area.scrollTop=0;area.dispatchEvent(new Event('scroll'))",
    );
    await page.wait(2200);
    assert.equal(
      await page.evaluate(
        "document.querySelector('.product-tool-progress-tail').getBoundingClientRect().height===window.__progressScroll",
      ),
      true,
    );
    assert.equal(
      await page.evaluate("document.querySelector('.product-chat-scroll').scrollTop"),
      0,
      "Progress scrolled the transcript",
    );
    await select();
    await page.waitFor("document.querySelector('.product-tool-progress button')", 15000);
    assert.equal(
      await page.evaluate(
        "document.querySelector('.product-tool-progress button').getAttribute('aria-expanded')",
      ),
      "false",
    );
    await page.evaluate("document.querySelector('.product-tool-progress button').click()");
    await page.waitFor(
      "document.querySelector('.product-tool-progress-tail')?.textContent.includes('OBS_TICK_')",
      15000,
    );
    if (process.env.PI_CLOUD_TOOL_PROGRESS_RESTART_CHECK === "1") {
      const { stdout } = await exec("docker", [
        "exec",
        "pi-cloud-production-postgres-1",
        "psql",
        "-U",
        "pi_cloud",
        "-d",
        "pi_cloud",
        "-Atc",
        "select id from runs where state in ('queued','running','cancelling') order by id",
      ]);
      assert.equal(stdout.trim(), active.runId, "Refuse process fault while other Runs are active");
      const before = snapshots;
      await exec("docker", ["kill", "--signal=KILL", "pi-cloud-production-control-plane-1"]);
      await exec("docker", ["start", "pi-cloud-production-control-plane-1"]);
      // Replace the Projector process, not the Worker or the running Tool.
      await page.waitFor(
        "document.querySelector('.product-tool-progress-tail')?.textContent.includes('OBS_TICK_')",
        25000,
      );
      const deadline = Date.now() + 25000;
      while (snapshots <= before && Date.now() < deadline) await page.wait(250);
      assert(snapshots > before, "No replacement snapshot after Projector restart");
      const updateCount = updates.length;
      while (updates.length <= updateCount && Date.now() < deadline) await page.wait(250);
      assert(updates.length > updateCount, "No new progress after Projector restart");
      report.projectorRestart = true;
    }
    const run = await waitRun(active.runId);
    assert.equal(run.state, "completed", JSON.stringify(run.failure));
    await page.waitFor("document.querySelector('.product-tool-progress')===null", 15000);
    const turn = (await api.getConversation(session.sessionId)).turns.find(
      (t) => t.runId === active.runId,
    );
    const tools = turn.transcript.items.filter((i) => i.kind === "tool");
    assert.equal(tools.length, 1, "Process fault must not replay the command");
    assert.equal(tools[0].status, "completed");
    assert(JSON.stringify(tools[0].output).includes("OBS_DONE"));
    assert(Buffer.byteLength(JSON.stringify(tools[0].output)) < 65536);
    const sampled = updates.filter((u) => u.turnId === active.turnId);
    assert(sampled.length >= 3);
    assert(sampled.every((u) => u.text.length <= 8192));
    report.runs.push({
      kind: "continuous-output",
      elapsedMs: Date.now() - started,
      progressCount: sampled.length,
      maximumProgressCharacters: Math.max(...sampled.map((u) => u.text.length)),
      modelTransportMs: (await readWorkerModelTimings([active.runId], started)).reduce(
        (sum, t) => sum + t.elapsedMs,
        0,
      ),
      commandExecutions: tools.length,
    });
    const silentStart = Date.now();
    active = await api.acceptTurn(
      session.sessionId,
      "只执行一次 bash：sleep 25。不要增加 echo 或其他命令，完成后回复完成。",
      newIdempotencyKey("silent-progress"),
      "low",
    );
    assert.equal((await waitRun(active.runId)).state, "completed");
    assert.equal(updates.filter((u) => u.turnId === active.turnId).length, 0);
    report.runs.push({
      kind: "silent-command",
      elapsedMs: Date.now() - silentStart,
      progressCount: 0,
    });
    active = await api.acceptTurn(
      session.sessionId,
      "只执行一次 bash：echo CANCEL_STARTED; sleep 90; echo CANCEL_FINISHED。不要后台运行，不要其他工具。",
      newIdempotencyKey("cancel-progress"),
      "low",
    );
    const deadline = Date.now() + 60000;
    while (!updates.some((u) => u.turnId === active.turnId) && Date.now() < deadline)
      await page.wait(250);
    assert(updates.some((u) => u.turnId === active.turnId));
    await api.cancelTurn(session.sessionId, active.turnId, newIdempotencyKey("cancel-observation"));
    assert.equal((await waitRun(active.runId)).state, "cancelled");
    await page.waitFor("document.querySelector('.product-tool-progress')===null", 15000);
    const count = updates.length;
    await page.wait(2500);
    assert.equal(updates.length, count, "Cancelled Tool leaked late progress");
    report.runs.push({ kind: "cancel", lateProgress: 0 });
    active = await api.acceptTurn(
      session.sessionId,
      "继续这个会话。依次实际使用四种工具：write 创建 insertion_sort.py，实现插入排序和空数组、重复值、负数、逆序的 assert 测试；read 读取它；edit 新增固定随机种子的随机测试；bash 执行 python3 insertion_sort.py。不要搜索或子代理，最后简要报告测试结果。",
      newIdempotencyKey("progress-coding"),
      "low",
    );
    assert.equal((await waitRun(active.runId)).state, "completed");
    const coding = (await api.getConversation(session.sessionId)).turns.find(
      (t) => t.runId === active.runId,
    );
    const calls = coding.transcript.items.filter((item) => item.kind === "tool");
    for (const name of ["write", "read", "edit", "bash"])
      assert(
        calls.some((call) => call.toolName === name && call.status === "completed"),
        `Missing completed ${name}`,
      );
    report.runs.push({
      kind: "coding-after-cancel",
      tools: calls.map((call) => ({ name: call.toolName, status: call.status })),
    });
  });
  report.accepted = true;
} finally {
  abort.abort();
  await stream?.catch(() => {});
  if (active && !terminal(await api.getRun(active.runId))) {
    await api.cancelTurn(
      session.sessionId,
      active.turnId,
      newIdempotencyKey("cleanup-progress-cancel"),
    );
    await waitRun(active.runId);
  }
  if (session)
    await api.deleteConversation(session.sessionId, newIdempotencyKey("cleanup-progress-session"));
  if (project)
    await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("cleanup-progress-workspace"));
  report.resourcesReleased = true;
  await writeFile(
    "docs/reports/tool-progress-acceptance-latest.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
}
