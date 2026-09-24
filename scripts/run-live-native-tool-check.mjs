import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { readWorkerModelTimings } from "./lib/live-run-timing.mjs";

if (process.env.PI_CLOUD_LIVE_NATIVE_TOOL_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_NATIVE_TOOL_CHECK=1 to permit Luna tokens and a disposable Cube Workspace",
  );
const port = (await readFile("deploy/production/runtime/.env", "utf8")).match(
  /^PI_CLOUD_HTTP_PORT=(\d+)$/m,
)?.[1];
assert(port, "Production HTTP port is missing");
const token = (await readFile("deploy/production/runtime/secrets/api-token", "utf8")).trim();
const api = new PiCloudApi(
  (input, init) => fetch(new URL(String(input), `http://127.0.0.1:${port}`), init),
  token,
);
const report = {
  checkedAt: new Date().toISOString(),
  model: "gpt-5.6-luna",
  accepted: false,
  runs: [],
};
let project, session, active, failure;
const pause = () => new Promise((resolve) => setTimeout(resolve, 250));
const isTerminal = (run) => ["completed", "failed", "cancelled", "timed_out"].includes(run.state);
async function waitForRun(id, timeoutMs = 600000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await api.getRun(id);
    if (isTerminal(run)) return run;
    await pause();
  }
  throw new Error("Native Tool acceptance Run did not settle");
}
try {
  project = await api.createProject(`Native Tool acceptance ${Date.now()}`);
  session = await api.createSession(
    project.projectId,
    project.workspaceId,
    "Native Tool acceptance",
    "elastic",
    "starter",
    "/workspace",
    {
      provider: "openai-codex",
      modelId: report.model,
      thinkingLevel: "low",
      fastMode: false,
    },
  );
  report.resources = {
    projectId: project.projectId,
    workspaceId: project.workspaceId,
    sessionId: session.sessionId,
  };
  for (const [index, prompt] of [
    "严格按顺序使用工具：write 创建 insertion_sort.py，实现插入排序及空数组、重复值、负数、逆序 assert 测试；read 读取它；edit 新增固定随机种子的随机测试；bash 执行 python3 insertion_sort.py。不要子代理或搜索，实际运行后简要报告。",
    '保留 insertion_sort.py。write 新建 binary_search.py，实现二分查找，覆盖命中、不存在、空数组、重复值测试。bash 执行 python3 insertion_sort.py && python3 binary_search.py。然后另一次 bash 执行 python3 -c \'print("x"*1500000); print("LARGE_OUTPUT_DONE")\'，不要修改这个大输出命令，也不要把它重定向到文件。不要子代理或搜索。最后简要报告。',
  ].entries()) {
    const started = Date.now();
    active = await api.acceptTurn(
      session.sessionId,
      prompt,
      newIdempotencyKey("native-tool-acceptance"),
      "low",
    );
    const run = await waitForRun(active.runId);
    assert.equal(run.state, "completed", JSON.stringify(run.failure));
    const turn = (await api.getConversation(session.sessionId)).turns.find(
      (t) => t.runId === active.runId,
    );
    const tools = turn.transcript.items.filter((item) => item.kind === "tool");
    assert(tools.length > 0, "Model did not execute tools");
    for (const tool of tools) assert.equal(tool.status, "completed", `${tool.toolName} failed`);
    for (const name of index === 0 ? ["write", "read", "edit", "bash"] : ["write", "bash"])
      assert(
        tools.some((tool) => tool.toolName === name),
        `Missing native ${name}`,
      );
    if (index === 1) {
      const large = tools.find(
        (tool) => tool.toolName === "bash" && JSON.stringify(tool.input).includes("1500000"),
      );
      assert(large, "Large-output Bash was not executed");
      const output = JSON.stringify(large.output);
      assert(output.includes("LARGE_OUTPUT_DONE"), "The source tail lost its completion marker");
      assert(Buffer.byteLength(output) < 64 * 1024, "Unbounded output reached canonical history");
    }
    const modelTimings = await readWorkerModelTimings([active.runId], started);
    report.runs.push({
      runId: active.runId,
      elapsedMs: Date.now() - started,
      modelTransportMs: modelTimings.reduce((sum, item) => sum + item.elapsedMs, 0),
      tools: tools.map((tool) => ({
        name: tool.toolName,
        state: tool.status,
        durationMs: Date.parse(tool.completedAt) - Date.parse(tool.startedAt),
        resultBytes: Buffer.byteLength(JSON.stringify(tool.output)),
      })),
    });
    console.log(JSON.stringify(report.runs.at(-1)));
  }
  report.accepted = true;
} catch (error) {
  failure = error;
} finally {
  const cleanupErrors = [];
  if (active && session) {
    try {
      if (!isTerminal(await api.getRun(active.runId))) {
        await api.cancelTurn(
          session.sessionId,
          active.turnId,
          newIdempotencyKey("native-clean-cancel"),
        );
        await waitForRun(active.runId, 120000);
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (session) {
    try {
      await api.deleteConversation(session.sessionId, newIdempotencyKey("native-clean-session"));
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (project) {
    try {
      await api.deleteWorkspace(project.workspaceId, newIdempotencyKey("native-clean-workspace"));
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  report.cleanupCompleted = cleanupErrors.length === 0;
  await writeFile(
    "docs/reports/native-tools-acceptance-latest.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  if (failure || cleanupErrors.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...cleanupErrors],
      "Native Tool acceptance failed",
    );
}
