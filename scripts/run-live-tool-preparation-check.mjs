import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile } from "node:fs/promises";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { streamSessionEvents } from "../packages/web-ui/src/sse.ts";
import { withChromePage } from "./lib/chrome-cdp.mjs";

if (process.env.PI_CLOUD_LIVE_TOOL_PREPARATION_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_TOOL_PREPARATION_CHECK=1 to permit a real browser, model tokens and disposable Workspace",
  );
const env = Object.fromEntries(
  (await readFile("deploy/production/runtime/.env", "utf8"))
    .split(/\r?\n/)
    .filter((line) => line.includes("="))
    .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
);
const base = `http://127.0.0.1:${env.PI_CLOUD_HTTP_PORT}`;
const suffix = Date.now().toString(36),
  username = `tool.ui.${suffix}`,
  password = `Tool acceptance ${suffix} !9`;
let cookie = "",
  project,
  session;
const fetchApi = async (path, init = {}) => {
  const response = await fetch(new URL(path, base), {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init.headers)), ...(cookie ? { cookie } : {}) },
  });
  for (const value of response.headers.getSetCookie())
    if (value.startsWith("pi_cloud_session=")) cookie = value.split(";")[0];
  return response;
};
const api = new PiCloudApi(fetchApi);
const exec = promisify(execFile);
async function resultCacheMetrics() {
  const { stdout } = await exec(
    "docker",
    [
      "exec",
      "pi-cloud-production-tool-broker-1",
      "node",
      "-e",
      "const token=require('node:fs').readFileSync(process.env.PI_CLOUD_METRICS_TOKEN_FILE,'utf8').trim();fetch('http://127.0.0.1:9466/metrics',{headers:{authorization:'Bearer '+token}}).then(r=>{if(!r.ok)throw new Error('Metrics HTTP '+r.status);return r.text()}).then(t=>process.stdout.write(t))",
    ],
    { timeout: 10000, maxBuffer: 1024 * 1024 },
  );
  const sample = (name, label = "") => {
    const line = stdout
      .split("\n")
      .find((line) => line.startsWith(name + "{") && line.includes(label));
    assert(line, `Missing Broker metric ${name} ${label}`);
    return Number(line.split(" ").at(-1));
  };
  return {
    bytes: sample("pi_cloud_tool_result_cache_bytes"),
    // A Counter with no native result yet has no labelled sample.
    nativeResults: stdout
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("pi_cloud_tool_result_cache_released_total{") &&
          line.includes('reason="native_result"'),
      )
      .reduce((sum, line) => sum + Number(line.split(" ").at(-1)), 0),
  };
}
const events = [],
  report = { checkedAt: new Date().toISOString(), username, runs: [], accepted: false };
const streamAbort = new AbortController();
let stream;
try {
  await api.registerAccount(username, "Tool UI Acceptance", password);
  project = await api.createProject(`Tool UI ${suffix}`);
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    `Tool UI ${suffix}`,
    "elastic",
    "starter",
    "/workspace",
    { provider: "deepseek", modelId: "deepseek-v4-flash", thinkingLevel: "off", fastMode: false },
  );
  report.sessionId = session.sessionId;
  stream = streamSessionEvents({
    sessionId: session.sessionId,
    signal: streamAbort.signal,
    fetchImplementation: fetchApi,
    onSnapshot() {},
    onStatus() {},
    onEvent(event) {
      if (["assistant.tool_call.preparing", "tool.started", "tool.completed"].includes(event.type))
        events.push({
          type: event.type,
          name: event.payload.toolName,
          id: event.payload.toolCallId,
          at: Date.now(),
        });
    },
  });
  await withChromePage({ profilePrefix: "pi-cloud-tool-preparation-" }, async (page) => {
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
        `Array.from(document.querySelectorAll('button')).some(b=>b.textContent.includes(${JSON.stringify(`Tool UI ${suffix}`)}))`,
      );
      await page.evaluate(
        `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes(${JSON.stringify(`Tool UI ${suffix}`)})).click()`,
      );
    };
    await select();
    async function run(prompt, expectedTool, reload) {
      const cacheBefore = await resultCacheMetrics();
      const start = Date.now(),
        before = events.length;
      const accepted = await api.acceptTurn(
        session.sessionId,
        prompt,
        newIdempotencyKey("tool-ui"),
        "off",
      );
      let seen,
        reloaded = false,
        completed = false;
      for (let i = 0; i < 1600; i++) {
        const preparing = await page.evaluate(
          `Array.from(document.querySelectorAll('.product-tool-preparing')).filter(e=>e.querySelector('code')?.textContent===${JSON.stringify(expectedTool)}).map(e=>({id:e.dataset.toolCallId,text:e.innerText,animation:getComputedStyle(e.querySelector('.product-tool-preparing-spinner')).animationName}))`,
        );
        if (preparing.length) {
          seen ??= { ...preparing[0], visibleAfterMs: Date.now() - start };
          if (reload && !reloaded) {
            const id = preparing[0].id;
            await select();
            await page.waitFor(
              `Array.from(document.querySelectorAll('.product-tool-preparing')).some(e=>e.dataset.toolCallId===${JSON.stringify(id)})`,
              15000,
            );
            reloaded = true;
          }
        }
        const state = await api.getRun(accepted.runId);
        if (state.state === "completed") {
          completed = true;
          break;
        }
        if (["failed", "cancelled", "timed_out", "superseded"].includes(state.state))
          throw new Error(`Run failed: ${JSON.stringify(state.failure)}`);
        await page.wait(250);
      }
      assert(completed, "Live Tool UI Run timed out");
      assert(seen, `Browser never showed ${expectedTool} preparation`);
      assert.notEqual(seen.animation, "none");
      assert.match(
        seen.text,
        expectedTool === "write"
          ? /正在生成文件内容|Generating file contents/
          : /正在生成代码修改|Generating code changes/,
      );
      if (reload) assert(reloaded, "Preparation was not recovered after browser reload");
      await page.waitFor("document.querySelectorAll('.product-tool-preparing').length===0");
      const callEvents = events.slice(before).filter((event) => event.id === seen.id);
      assert.equal(
        callEvents.filter((event) => event.type === "assistant.tool_call.preparing").length,
        1,
      );
      assert(callEvents.some((event) => event.type === "tool.started"));
      const cacheAfter = await resultCacheMetrics();
      assert(
        cacheAfter.nativeResults > cacheBefore.nativeResults,
        "Broker did not retire results from native Kafka acknowledgements",
      );
      assert.equal(cacheAfter.bytes, 0, "Completed Tool bodies remain cached after Run completion");
      report.runs.push({
        runId: accepted.runId,
        tool: expectedTool,
        elapsedMs: Date.now() - start,
        preparation: seen,
        restoredAfterRefresh: reloaded,
        resultCache: {
          before: cacheBefore,
          after: cacheAfter,
          nativeAcknowledgedOperations: cacheAfter.nativeResults - cacheBefore.nativeResults,
        },
      });
      console.log(
        `[tool-ui] ${expectedTool}: live animated preparation, execution and completion passed`,
      );
    }
    await run(
      "使用 write 工具创建 algorithms.py，写完整可运行的插入排序、归并排序、二分查找和 unittest 测试，覆盖空数组、负数、重复值、逆序及固定种子的随机数据。代码约150行，不要占位或只写说明。必须用 write 传入完整文件内容，不要通过 bash/heredoc 生成文件。最后用 bash 执行 python3 algorithms.py 确认全部通过。不要调用子代理或搜索。",
      "write",
      true,
    );
    await run(
      "先读取 algorithms.py，必须使用 edit 工具在保留原有内容的基础上新增堆排序实现和约60行的完整测试，覆盖多个随机数组、重复值、已经排序的数组、负数。不要通过 bash 重写文件。最后运行 python3 algorithms.py，确保新增与原有测试全部通过。不要调用子代理或搜索。",
      "edit",
      false,
    );
  });
  report.accepted = true;
} finally {
  streamAbort.abort();
  await stream?.catch(() => undefined);
  if (session)
    await api.deleteConversation(session.sessionId, newIdempotencyKey("delete-tool-ui-session"));
  if (project)
    await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("delete-tool-ui-workspace"));
  report.resourcesReleased = true;
  await writeFile(
    "docs/reports/tool-preparation-acceptance-latest.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  console.log(JSON.stringify(report));
}
