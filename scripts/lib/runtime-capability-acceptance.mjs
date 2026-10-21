import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { controlToolCatalog } from "../../packages/control-plane/src/control-tool-registry.ts";
import { previewToolDefinition } from "../../packages/control-plane/src/control-preview-tool.ts";
import { newIdempotencyKey } from "../../packages/web-ui/src/api.ts";
import { nativeMessages } from "./native-session-history.mjs";
import {
  kubectl,
  kubeconfig,
  namespace,
  repositoryRoot,
  workload,
} from "./production-kubernetes.mjs";
import { scopedHelmUpgradeArguments } from "./component-release.mjs";
import { withChromePage } from "./chrome-cdp.mjs";

const terminal = (state) => ["completed", "failed", "cancelled", "timed_out"].includes(state);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(read, name, timeoutMs = 300_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const value = await read();
    if (value) return value;
    await pause(250);
  }
  throw new Error(`${name} timed out`);
}
const helm = (...args) =>
  execFileSync(
    process.env.PI_CLOUD_HELM_BIN ?? "helm",
    [...args, "--kubeconfig", kubeconfig, "--namespace", namespace],
    { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
function workerPods() {
  const selected = JSON.parse(kubectl(["get", workload("pi-workers"), "-o", "json"])).spec.selector
    .matchLabels;
  const selector = Object.entries(selected)
    .map(([key, value]) => `${key}=${value}`)
    .join(",");
  return JSON.parse(kubectl(["get", "pods", "-l", selector, "-o", "json"]))
    .items.map((pod) => ({
      name: pod.metadata.name,
      uid: pod.metadata.uid,
      restarts: pod.status.containerStatuses?.map((container) => ({
        name: container.name,
        restarts: container.restartCount,
      })),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
function toolsIn(rows) {
  return getCurrentTools(nativeMessages(rows)).map((tool) => tool.name);
}
function callsIn(rows) {
  return nativeMessages(rows)
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content ?? [])
    .filter((part) => part.type === "toolCall");
}
function sectionsIn(rows, key) {
  return nativeMessages(rows)
    .filter((message) => message.role === "system" && message.sections?.[key])
    .map((message) => message.sections[key]);
}

/** Owned live work only. The caller holds the release lock and cleans this Session/Workspace. */
export async function runtimeCapabilityAcceptance({
  db,
  api,
  tenant,
  session,
  baseUrl,
  directory,
  completed,
  history,
  progress,
  save,
}) {
  const result = { accepted: false, catalogConfigurationRestored: false, runs: [] };
  const settings = async (thinkingLevel, provider = "openai-codex", modelId = "gpt-6-luna") =>
    api.updateSessionModel(session.sessionId, {
      provider,
      modelId,
      thinkingLevel,
      fastMode: false,
    });
  const start = (prompt, thinking) =>
    api.acceptTurn(session.sessionId, prompt, newIdempotencyKey("runtime-capability"), thinking);
  const finish = async (run) => {
    const rows = await completed(run.runId);
    result.runs.push(run.runId);
    return rows;
  };
  const checkpointEfforts = async (runId) => {
    const snapshot = await db
      .selectFrom("runs")
      .select("thinking_level")
      .where("id", "=", runId)
      .executeTakeFirstOrThrow();
    const binding = await db
      .selectFrom("sessions")
      .select("pi_session_id")
      .where("id", "=", session.sessionId)
      .executeTakeFirstOrThrow();
    assert(binding.pi_session_id);
    const logs = await db
      .selectFrom("pi_durable_log")
      .select("body")
      .where("tenant_id", "=", tenant.tenantId)
      .where("session_id", "=", binding.pi_session_id)
      .execute();
    const requests = logs
      .map((row) => JSON.parse(row.body))
      .filter(
        (write) =>
          write.type === "task" &&
          write.value?.kind === "pi.generation" &&
          write.value.state?.checkpoint?.thinkingLevel,
      )
      .map((write) => ({
        conversationId: write.value.conversationId,
        effort: write.value.state.checkpoint.thinkingLevel,
      }));
    return { selected: snapshot.thinking_level, requests };
  };

  progress("runtime capabilities: real guest public egress and Max policy");
  await settings("max");
  const network = await start(
    "只调用一次 bash，使用 Python urllib.request 分别 GET https://registry.npmjs.org/typescript/latest 和 https://pypi.org/pypi/pip/json，仅打印两个 HTTP 状态码，然后回复 NETWORK_OK。不要安装依赖、搜索或委派。",
    "max",
  );
  const networkHistory = await finish(network);
  assert.equal(
    callsIn(networkHistory).filter((call) => call.name === "subagent" || call.name === "workflow")
      .length,
    0,
  );
  assert(
    nativeMessages(networkHistory).some(
      (message) =>
        message.role === "toolResult" &&
        message.content.some(
          (part) => part.type === "text" && (part.text.match(/200/g)?.length ?? 0) >= 2,
        ),
    ),
    "Guest registry requests were not confirmed",
  );
  assert(
    sectionsIn(networkHistory, "cloud-network").some((text) =>
      text.includes("enabled through its configured proxy"),
    ),
  );
  assert(
    sectionsIn(networkHistory, "delegation-policy").some((text) =>
      text.includes("only when the user"),
    ),
  );
  result.guestEgress = true;

  progress("runtime capabilities: Ultra native child and compact browser progress");
  await settings("ultra");
  const delegated = await start(
    "请调用一次 subagent，把任务‘只执行 bash 命令 sleep 30; printf CHILD_OK，然后回复 CHILD_OK；不要创建更多子 Agent’交给它。你等待结果后只回复 PARENT_OK。不要做其他工作。",
    "ultra",
  );
  await withChromePage({}, async (page) => {
    await page.send("Network.setExtraHTTPHeaders", {
      headers: { Authorization: "Bearer " + tenant.credential.token },
    });
    await page.navigate(`${baseUrl}/?session=${session.sessionId}`);
    await page.waitFor("document.querySelector('.product-child-progress button')", 180_000);
    await page.waitFor(
      "Array.from(document.querySelectorAll('.product-child-phase')).some(e=>/执行工具|Running tools/.test(e.textContent))",
      60_000,
    );
    assert(
      await page.evaluate(
        "Array.from(document.querySelectorAll('.product-tool[data-tool-name=subagent] details')).every(e=>!e.open)",
      ),
    );
    const tree = await api.getConversationTree(session.sessionId, "full");
    const child = tree.delegatedSessions.find((item) => item.parentTurnId === delegated.turnId);
    assert(
      child?.parentToolCallId && child.turnId,
      "Child relationship is not available before the final reply",
    );
    await page.screenshot(resolve(directory, "child-progress.png"));
    await page.evaluate("document.querySelector('.product-child-progress button').click()");
    await page.waitFor(`location.search.includes(${JSON.stringify(child.sessionId)})`);
    result.childProgress = {
      compact: true,
      detailsClosed: true,
      navigation: true,
      childSessionId: child.sessionId,
    };
  });
  const childHistory = await finish(delegated);
  assert(callsIn(childHistory).some((call) => call.name === "subagent"));
  assert(
    sectionsIn(childHistory, "delegation-policy").some((text) =>
      text.includes("may proactively delegate"),
    ),
  );
  assert(
    new Set(
      childHistory
        .filter((row) =>
          row.entry.model?.some(
            (message) =>
              message.role === "system" &&
              message.sections?.["delegation-policy"]?.includes("may proactively delegate"),
          ),
        )
        .map((row) => row.entry.conversationId),
    ).size >= 2,
    "Parent and child must retain the proactive profile",
  );
  const efforts = await checkpointEfforts(delegated.runId);
  assert.equal(efforts.selected, "ultra");
  assert(
    efforts.requests.some((request) => request.conversationId > 1 && request.effort === "max"),
    "Child did not retain provider Max",
  );
  result.ultra = { selected: efforts.selected, childProviderMax: true };

  progress("runtime capabilities: explicit delegation remains available at Max");
  await settings("max");
  const explicit = await start(
    "请明确使用一次 subagent，tools 设置为 []，让它只回复 EXPLICIT_CHILD_OK，不要再委派。你拿到结果后回复 EXPLICIT_PARENT_OK。",
    "max",
  );
  const explicitHistory = await finish(explicit);
  assert(callsIn(explicitHistory).some((call) => call.name === "subagent"));
  assert(
    sectionsIn(explicitHistory, "delegation-policy").some((text) =>
      text.includes("only when the user"),
    ),
  );
  result.explicitDelegation = true;

  const other = await db
    .selectFrom("runs")
    .select("id")
    .where("tenant_id", "!=", tenant.tenantId)
    .where("state", "not in", ["completed", "failed", "cancelled", "timed_out"])
    .execute();
  assert.equal(other.length, 0, "Catalog restart acceptance must not change unrelated active work");
  const before = JSON.parse(helm("get", "values", "pi-cloud", "--output", "json"));
  const original = before.controlPlane?.enabledControlTools ?? null;
  let expected = original;
  const receipt = { original, expected, restored: false };
  await writeFile(
    resolve(directory, "tool-catalog-configuration.json"),
    JSON.stringify(receipt, null, 2),
    { mode: 0o600 },
  );
  const swap = async (enabled) => {
    const values = JSON.parse(helm("get", "values", "pi-cloud", "--output", "json"));
    assert(
      isDeepStrictEqual(values.controlPlane?.enabledControlTools ?? null, expected),
      "Tool catalog configuration changed concurrently",
    );
    values.controlPlane.enabledControlTools = enabled;
    const file = resolve(directory, "tool-catalog-values.json");
    await writeFile(file, JSON.stringify(values), { mode: 0o600 });
    const workers = workerPods();
    const since = new Date().toISOString();
    receipt.expected = enabled;
    await writeFile(
      resolve(directory, "tool-catalog-configuration.json"),
      JSON.stringify(receipt, null, 2),
      { mode: 0o600 },
    );
    execFileSync(
      process.env.PI_CLOUD_HELM_BIN ?? "helm",
      scopedHelmUpgradeArguments({
        name: "pi-cloud",
        chart: resolve(repositoryRoot, "deploy/helm/pi-cloud-platform"),
        values: file,
        kubeconfig,
        namespace,
      }),
      { stdio: "pipe", timeout: 330_000 },
    );
    expected = enabled;
    assert.deepEqual(workerPods(), workers, "Catalog change replaced a Worker");
    const revision = controlToolCatalog(
      enabled?.length === 0 ? [] : [previewToolDefinition],
    ).revision;
    await until(
      () =>
        workers.every((worker) =>
          kubectl(["logs", worker.name, "--since-time", since, "--tail=1000"])
            .split("\n")
            .some((line) => {
              try {
                const event = JSON.parse(line);
                return (
                  event.event === "runtime.tool_catalog_changed" &&
                  event.attributes?.revision === revision
                );
              } catch {
                return false;
              }
            }),
        ),
      "Worker catalog delivery",
      60_000,
    );
  };
  const runningBash = (run) =>
    until(async () => {
      const current = await api.getRun(run.runId);
      if (terminal(current.state)) throw new Error("Catalog gate ended before replacement");
      const conversation = await api.getConversation(session.sessionId);
      return conversation.turns
        .find((turn) => turn.runId === run.runId)
        ?.transcript?.items.some(
          (item) => item.kind === "tool" && item.toolName === "bash" && item.status === "running",
        );
    }, "Catalog gate Bash");
  const lease = (run) =>
    db
      .selectFrom("runs")
      .select(["lease_id", "fencing_token"])
      .where("id", "=", run.runId)
      .executeTakeFirstOrThrow();
  const gateCommand = (name) =>
    `for i in $(seq 1 240); do if find /workspace -name '${name}' -print -quit | grep -q .; then printf CATALOG_READY; exit 0; fi; sleep 1; done; exit 1`;
  const releaseGate = (name) =>
    api.uploadWorkspaceFile(
      session.sessionId,
      randomUUID(),
      new Blob(["ready"], { type: "text/plain" }),
      name,
    );
  try {
    progress("runtime capabilities: withdraw ordinary tools before opening a gated loop");
    await swap([]);
    const name = `catalog-add-${randomUUID()}.txt`;
    const run = await start(
      "先只调用一次 bash，执行以下命令，等待其完成：\n" +
        `nohup python3 -m http.server 18765 --bind 0.0.0.0 >/tmp/catalog-http.log 2>&1 </dev/null &\n${gateCommand(name)}` +
        "\n工具结束后重新查看当前可用工具；调用 preview，port 为 18765，然后回复 CATALOG_ADDED。不要搜索或委派。",
      "max",
    );
    await runningBash(run);
    assert(!toolsIn(await history(run.runId)).includes("preview"));
    const owner = await lease(run);
    progress("runtime capabilities: add preview during the same active loop");
    await swap(["preview"]);
    assert.deepEqual(
      await lease(run),
      owner,
      "Control Plane replacement changed the active writer",
    );
    await releaseGate(name);
    const rows = await finish(run);
    assert(toolsIn(rows).includes("preview"));
    assert(callsIn(rows).some((call) => call.name === "preview"));
    assert(
      nativeMessages(rows).some(
        (message) =>
          message.role === "toolResult" && message.toolName === "preview" && !message.isError,
      ),
    );
    result.catalogAddition = {
      sameRun: true,
      sameWriter: true,
      sameWorkers: true,
      previewCompleted: true,
    };

    const removedGate = `catalog-remove-${randomUUID()}.txt`;
    const removed = await start(
      "只调用一次 bash，执行以下命令并等待：\n" +
        gateCommand(removedGate) +
        "\n工具结束后仅回复你当前是否还能看到 preview 工具，不要再调用工具、搜索或委派。",
      "max",
    );
    await runningBash(removed);
    assert(toolsIn(await history(removed.runId)).includes("preview"));
    const previous = await lease(removed);
    progress("runtime capabilities: withdraw preview during an active loop");
    await swap([]);
    assert.deepEqual(await lease(removed), previous);
    await releaseGate(removedGate);
    const removedHistory = await finish(removed);
    assert(!toolsIn(removedHistory).includes("preview"));
    result.catalogWithdrawal = { sameRun: true, sameWriter: true, sameWorkers: true };
  } finally {
    const current = JSON.parse(helm("get", "values", "pi-cloud", "--output", "json"));
    const actual = current.controlPlane?.enabledControlTools ?? null;
    assert(
      isDeepStrictEqual(actual, expected) || isDeepStrictEqual(actual, receipt.expected),
      "Tool catalog changed outside acceptance; refusing to overwrite it",
    );
    expected = actual;
    if (!isDeepStrictEqual(actual, original)) await swap(original);
    receipt.restored = true;
    result.catalogConfigurationRestored = true;
    await writeFile(
      resolve(directory, "tool-catalog-configuration.json"),
      JSON.stringify(receipt, null, 2),
      { mode: 0o600 },
    );
    await save(result);
  }

  progress("runtime capabilities: DeepSeek Max mapping and ordinary function calls");
  await settings("ultra", "deepseek", "deepseek-v4-flash");
  const deepseek = await start(
    "只调用一次 bash 执行 printf DEEPSEEK_TOOL_OK，然后只回复 DEEPSEEK_OK。不要搜索、委派或执行其他命令。",
    "ultra",
  );
  const deepseekHistory = await finish(deepseek);
  assert(callsIn(deepseekHistory).some((call) => call.name === "bash"));
  assert(toolsIn(deepseekHistory).includes("preview"));
  result.deepseek = {
    model: "deepseek-v4-flash",
    selectedUltra: true,
    nativeToolCompleted: true,
    hostedSearchTested: false,
  };
  result.accepted = true;
  return result;
}
