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
  model: "gpt-6-luna",
  accepted: false,
  runs: [],
};
// Keep the IO contract independent of model-authored exact-match snippets.
// The native edit must replace this unique marker, and the final bytes are checked.
const insertionSort = `def insertion_sort(values):
    result = list(values)
    for i in range(1, len(result)):
        value = result[i]
        j = i - 1
        while j >= 0 and result[j] > value:
            result[j + 1] = result[j]
            j -= 1
        result[j + 1] = value
    return result

for values in [[], [2, 2, 1], [-3, 0, -1], [4, 3, 2, 1]]:
    assert insertion_sort(values) == sorted(values)
# EXTRA_TESTS
print("INSERTION_SORT_OK")
`;
const extraTests = `import random
rng = random.Random(7)
for _ in range(50):
    values = [rng.randint(-20, 20) for _ in range(30)]
    assert insertion_sort(values) == sorted(values)`;
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
    `严格按顺序调用一次 write、read、edit、bash。write 创建 insertion_sort.py，content 必须逐字使用此 JSON 字符串：${JSON.stringify(insertionSort)}。read 读取它。edit 的 path 为 insertion_sort.py，edits 必须使用此 JSON 数组：${JSON.stringify([{ oldText: "# EXTRA_TESTS", newText: extraTests }])}。bash 执行 python3 insertion_sort.py。不要改写给定代码或参数，不要子代理或搜索，实际运行后简要报告。`,
    '保留 insertion_sort.py。write 新建 binary_search.py，实现二分查找，覆盖命中、不存在、空数组、重复值测试。bash 执行 python3 insertion_sort.py && python3 binary_search.py。然后另一次 bash 执行 python3 -c \'print("x"*1500000); print("LARGE_OUTPUT_DONE")\'，不要修改这个大输出命令，也不要把它重定向到文件。不要子代理或搜索。最后简要报告。',
    "验证沙箱文件工具：write 向 /tmp/pi-cloud-parity.txt 写入 before；bash 执行 ln -s /tmp/pi-cloud-parity.txt parity-link.txt；read 读取 parity-link.txt；edit 通过 parity-link.txt 把 before 改为 after；read 读取 /tmp/pi-cloud-parity.txt；最后 bash 验证 test -L parity-link.txt 且文件内容为 after，成功输出 FILE_PARITY_OK。严格使用这些文件工具，不要用 bash 代替 read/write/edit，不要子代理或搜索。",
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
    for (const name of index === 1 ? ["write", "bash"] : ["write", "read", "edit", "bash"])
      assert(
        tools.some((tool) => tool.toolName === name),
        `Missing native ${name}`,
      );
    if (index === 0) {
      const actual = Buffer.from(
        (await api.readWorkspaceFile(session.sessionId, "insertion_sort.py")).bytes,
      ).toString();
      assert.equal(actual, insertionSort.replace("# EXTRA_TESTS", extraTests));
    }
    if (index === 1) {
      const large = tools.find(
        (tool) => tool.toolName === "bash" && JSON.stringify(tool.input).includes("1500000"),
      );
      assert(large, "Large-output Bash was not executed");
      const output = JSON.stringify(large.output);
      assert(output.includes("LARGE_OUTPUT_DONE"), "The source tail lost its completion marker");
      assert(Buffer.byteLength(output) < 64 * 1024, "Unbounded output reached canonical history");
    }
    if (index === 2) {
      assert(
        tools.some(
          (tool) =>
            tool.toolName === "write" &&
            JSON.stringify(tool.input).includes("/tmp/pi-cloud-parity.txt"),
        ),
      );
      assert(
        tools.some(
          (tool) =>
            tool.toolName === "edit" && JSON.stringify(tool.input).includes("parity-link.txt"),
        ),
      );
      assert(
        tools.some(
          (tool) =>
            tool.toolName === "bash" && JSON.stringify(tool.output).includes("FILE_PARITY_OK"),
        ),
      );
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
      await api.deleteConversation(session.sessionId);
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
    process.env.PI_CLOUD_LIVE_NATIVE_TOOL_REPORT ??
      "docs/reports/native-tools-acceptance-latest.json",
    JSON.stringify(report, null, 2) + "\n",
  );
  if (failure || cleanupErrors.length)
    throw new AggregateError(
      [...(failure ? [failure] : []), ...cleanupErrors],
      "Native Tool acceptance failed",
    );
}
