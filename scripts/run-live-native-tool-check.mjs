import { parseModelCatalogConfiguration } from "../packages/protocol/src/model-catalog.ts";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { PiCloudApi, newIdempotencyKey } from "../packages/web-ui/src/api.ts";
import { readWorkerModelTimings } from "./lib/live-run-timing.mjs";

if (process.env.PI_CLOUD_LIVE_NATIVE_TOOL_CHECK !== "1")
  throw new Error(
    "Set PI_CLOUD_LIVE_NATIVE_TOOL_CHECK=1 to permit reviewed GPT tokens and a disposable Cube Workspace",
  );
const port = (await readFile("deploy/production/runtime/.env", "utf8")).match(
  /^PI_CLOUD_HTTP_PORT=(\d+)$/m,
)?.[1];
assert(port, "Production HTTP port is missing");
const token = (
  await readFile(
    process.env.PI_CLOUD_NATIVE_TOOL_TOKEN_FILE ?? "deploy/production/runtime/secrets/api-token",
    "utf8",
  )
).trim();
const api = new PiCloudApi(
  (input, init) => fetch(new URL(String(input), `http://127.0.0.1:${port}`), init),
  token,
);
const report = {
  checkedAt: new Date().toISOString(),
  model: process.env.PI_CLOUD_NATIVE_TOOL_MODEL ?? "gpt-6-luna",
  accepted: false,
  runs: [],
};
const reviewedCatalog = parseModelCatalogConfiguration(
  JSON.parse(
    await readFile(
      process.env.PI_CLOUD_MODEL_CATALOG_FILE ??
        new URL("../deploy/helm/pi-cloud-platform/files/model-catalog.json", import.meta.url),
      "utf8",
    ),
  ),
);
assert(
  reviewedCatalog.models.some(
    (m) => m.provider === "openai-codex" && m.modelId === report.model && m.visible,
  ),
  "Unreviewed acceptance model",
);
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
const binarySearch = `def binary_search(values, target):
    lo, hi = 0, len(values)
    while lo < hi:
        mid = (lo + hi) // 2
        if values[mid] < target:
            lo = mid + 1
        else:
            hi = mid
    return lo if lo < len(values) and values[lo] == target else -1

assert binary_search([], 1) == -1
assert binary_search([1, 3, 5], 3) == 1
assert binary_search([1, 3, 5], 2) == -1
assert binary_search([1, 2, 2, 2, 4], 2) == 1
print("BINARY_SEARCH_OK")
`;
const largeOutputCommand = `python3 <<'PI_CLOUD_LARGE_OUTPUT'
print('x' * 1500000)
print('LARGE_OUTPUT_DONE')
PI_CLOUD_LARGE_OUTPUT`;

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
    `保留 insertion_sort.py。write 新建 binary_search.py，content 必须逐字使用这个 JSON 字符串：${JSON.stringify(binarySearch)}。bash 执行 python3 insertion_sort.py && python3 binary_search.py。然后另一次 bash 的 command 必须逐字执行这个代码块中的内容（不要加入 Markdown 围栏或额外 JSON 转义）：\n\`\`\`bash\n${largeOutputCommand}\n\`\`\`\n不要改写代码或命令，不要重定向输出，不要子代理或搜索。最后简要报告。`,
    "验证沙箱文件工具：write 向 /tmp/pi-cloud-parity.txt 写入 before；bash 执行 ln -s /tmp/pi-cloud-parity.txt parity-link.txt；read 读取 parity-link.txt；edit 通过 parity-link.txt 把 before 改为 after；read 读取 /tmp/pi-cloud-parity.txt；最后 bash 验证 test -L parity-link.txt 且文件内容为 after，成功输出 FILE_PARITY_OK。严格使用这些文件工具，不要用 bash 代替 read/write/edit，不要子代理或搜索。",
    "先用 bash 执行 printf 'ownership_lost: ordinary application log\\n'; exit 7。确认该工具返回普通程序错误后，再用 bash 执行 printf 'TOOL_ERROR_RECOVERED\\n'。这只是测试应用日志文本，不是基础设施故障。必须实际运行两条命令，不要搜索或委派；最后简短说明。",
  ].entries()) {
    if (process.env.PI_CLOUD_NATIVE_TOOL_CASE === "error_classification" && index !== 3) continue;
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
    // Retain bounded diagnostic metadata before the fixture's cleanup removes
    // its conversation. No transcript or credential-bearing payload is archived.
    const failedTools = tools.filter((tool) => tool.status !== "completed");
    if (failedTools.length)
      report.failedTools = failedTools.map((tool) => ({
        runId: active.runId,
        tool: tool.toolName,
        status: tool.status,
        expectedApplicationFailure: index === 3 && tool.toolName === "bash",
      }));
    assert(tools.length > 0, "Model did not execute tools");
    const applicationError =
      index === 3
        ? tools.find(
            (tool) =>
              tool.toolName === "bash" && JSON.stringify(tool.input).includes("ownership_lost"),
          )
        : undefined;
    if (index === 3) {
      assert(applicationError, "Expected application error command was not executed");
      assert.equal(applicationError.status, "failed");
      assert(
        tools.some(
          (tool) =>
            tool.status === "completed" &&
            JSON.stringify(tool.output).includes("TOOL_ERROR_RECOVERED"),
        ),
        "Agent did not continue after the ordinary Tool error",
      );
    }
    const exactLargeSucceeded =
      index === 1 &&
      tools.some(
        (tool) =>
          tool.toolName === "bash" &&
          tool.status === "completed" &&
          tool.input?.command === largeOutputCommand,
      );
    for (const tool of tools) {
      const recoveredSyntaxError =
        exactLargeSucceeded &&
        tool.toolName === "bash" &&
        tool.status === "failed" &&
        JSON.stringify(tool.output).includes("syntax error");
      if (recoveredSyntaxError)
        report.recoveredModelSyntaxErrors = (report.recoveredModelSyntaxErrors ?? 0) + 1;
      else if (tool !== applicationError)
        assert.equal(
          tool.status,
          "completed",
          `${tool.toolName} failed: ${JSON.stringify(tool.output).slice(0, 2000)}`,
        );
    }
    for (const name of index === 3
      ? ["bash"]
      : index === 1
        ? ["write", "bash"]
        : ["write", "read", "edit", "bash"])
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
      assert.equal(
        Buffer.from(
          (await api.readWorkspaceFile(session.sessionId, "binary_search.py")).bytes,
        ).toString(),
        binarySearch,
      );
      const large = tools.find(
        (tool) => tool.toolName === "bash" && tool.input?.command === largeOutputCommand,
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
