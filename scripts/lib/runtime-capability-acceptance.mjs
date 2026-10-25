import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { sql } from "kysely";
import { getCurrentSystemMessage, getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { controlToolCatalog } from "../../packages/control-plane/src/control-tool-registry.ts";
import { previewToolDefinition } from "../../packages/control-plane/src/ordinary-tools/preview-tool.ts";
import { newIdempotencyKey } from "../../packages/web-ui/src/api.ts";
import { nativeHistory, nativeMessages } from "./native-session-history.mjs";
import {
  kubectl,
  kubeconfig,
  namespace,
  repositoryRoot,
  workload,
} from "./production-kubernetes.mjs";
import { scopedHelmUpgradeArguments } from "./component-release.mjs";
import { withChromePage } from "./chrome-cdp.mjs";
import { armControlPlaneRestore } from "./owned-control-plane-outage.mjs";

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
export function runtimeCapabilityState(rows, conversationId) {
  const messages = nativeMessages(
    rows.filter((row) => Number(row.entry.conversationId) === Number(conversationId)),
  );
  return {
    tools: getCurrentTools(messages).map((tool) => tool.name),
    sections: getCurrentSystemMessage(messages)?.sections ?? {},
  };
}
function callsIn(rows) {
  return nativeMessages(rows)
    .filter((message) => message.role === "assistant")
    .flatMap((message) => message.content ?? [])
    .filter((part) => part.type === "toolCall");
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
  progress,
  save,
  scope = "all",
}) {
  assert(["all", "catalog"].includes(scope), "Unknown runtime capability acceptance scope");
  const result = { scope, accepted: false, catalogConfigurationRestored: false, runs: [] };
  const nativeSession = await db
    .selectFrom("sessions")
    .select(["pi_session_id", "pi_conversation_id"])
    .where("tenant_id", "=", tenant.tenantId)
    .where("id", "=", session.sessionId)
    .executeTakeFirstOrThrow();
  assert(nativeSession.pi_session_id && nativeSession.pi_conversation_id);
  // Pi only records changed sections/tools. Reconstruct the owned Conversation's
  // effective state across Runs, without mixing in a child's independent state.
  const currentState = async () =>
    runtimeCapabilityState(
      await nativeHistory(db, {
        tenantId: tenant.tenantId,
        sessionId: nativeSession.pi_session_id,
      }),
      nativeSession.pi_conversation_id,
    );
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

  if (scope === "all") {
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
    const networkState = await currentState();
    assert(
      networkState.sections["cloud-network"]?.includes("enabled through its configured proxy"),
      "The effective network section must retain the enabled policy across Runs",
    );
    assert(
      networkState.sections["delegation-policy"]?.includes("only when the user"),
      "Max must use explicit-request-only delegation instructions",
    );
    result.guestEgress = true;
    await save(result);

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
      await page.waitFor(
        `document.querySelector('[data-conversation-turn-id="${child.turnId}"]') && document.querySelector('.product-delegated-readonly')`,
      );
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
      (await currentState()).sections["delegation-policy"]?.includes("may proactively delegate"),
      "Ultra must use proactive delegation instructions",
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
    await save(result);

    progress("runtime capabilities: explicit delegation remains available at Max");
    await settings("max");
    const explicit = await start(
      "请明确使用一次 subagent，tools 设置为 []，让它只回复 EXPLICIT_CHILD_OK，不要再委派。你拿到结果后回复 EXPLICIT_PARENT_OK。",
      "max",
    );
    const explicitHistory = await finish(explicit);
    assert(callsIn(explicitHistory).some((call) => call.name === "subagent"));
    assert(
      (await currentState()).sections["delegation-policy"]?.includes("only when the user"),
      "Returning to Max must replace the proactive instructions",
    );
    result.explicitDelegation = true;
    await save(result);
  } else {
    progress("runtime catalog: prepare an owned warm Workspace");
    await settings("max");
    await finish(
      await start(
        "只调用一次 bash 执行 printf CATALOG_BASELINE_OK，然后回复 CATALOG_BASELINE_OK。不要搜索或委派。",
        "max",
      ),
    );
  }

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
    const restorePath = resolve(directory, `catalog-control-plane-${randomUUID()}.restore.json`);
    const oldOwners = await db
      .selectFrom("sandbox_control_instances")
      .select("instance_id")
      .where("sandbox_domain_id", "=", values.sandboxPlane.domainId)
      .where("state", "=", "ready")
      .where("lease_expires_at", ">", sql`clock_timestamp()`)
      .execute();
    const deployment = JSON.parse(kubectl(["get", workload("control-plane"), "-o", "json"]));
    assert.equal(deployment.spec.replicas, 1, "This fixture uses single-Control-Plane replacement");
    const stopped = await armControlPlaneRestore(restorePath, Date.now() + 180_000);
    try {
      kubectl(["scale", workload("control-plane"), "--current-replicas=1", "--replicas=0"]);
      kubectl(["wait", "--for=delete", "pod", "-l", stopped.selector, "--timeout=120s"], {
        timeout: 125_000,
      });
      await until(
        async () => {
          if (!oldOwners.length) return true;
          const live = await db
            .selectFrom("sandbox_control_instances")
            .select("instance_id")
            .where(
              "instance_id",
              "in",
              oldOwners.map((owner) => owner.instance_id),
            )
            .where("state", "=", "ready")
            .where("lease_expires_at", ">", sql`clock_timestamp()`)
            .execute();
          return live.length === 0;
        },
        "Previous sandbox-owner lease closure",
        30_000,
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
    } finally {
      const current = JSON.parse(kubectl(["get", workload("control-plane"), "-o", "json"]));
      assert.equal(current.metadata.uid, stopped.receipt.uid);
      if (current.spec.replicas === 0) await stopped.restore();
      else assert.equal(current.spec.replicas, stopped.receipt.replicas);
      // Helm changes the template and replica count atomically. Before that
      // patch the watchdog can restore the old template; afterward replicas
      // are already restored by the new desired Deployment.
      await writeFile(restorePath, JSON.stringify({ ...stopped.receipt, restored: true }), {
        mode: 0o600,
      });
    }
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
    result.catalogSwaps ??= [];
    result.catalogSwaps.push({
      enabled,
      at: new Date().toISOString(),
      workspaceOwners: await db
        .selectFrom("workspace_runtimes as runtime")
        .leftJoin(
          "sandbox_control_instances as owner",
          "owner.instance_id",
          "runtime.owner_instance_id",
        )
        .select([
          "runtime.state",
          "runtime.failure_code",
          "runtime.owner_base_url",
          "owner.state as ownerState",
          "owner.lease_expires_at",
        ])
        .where("runtime.tenant_id", "=", tenant.tenantId)
        .where("runtime.workspace_id", "=", session.workspaceId)
        .execute(),
      currentControlPlanePods: JSON.parse(
        kubectl(["get", "pods", "-l", "app.kubernetes.io/component=control-plane", "-o", "json"]),
      ).items.map((pod) => ({
        name: pod.metadata.name,
        ip: pod.status.podIP,
        deleting: Boolean(pod.metadata.deletionTimestamp),
      })),
    });
    await save(result);
  };
  const runningBash = (run) =>
    until(async () => {
      const current = await api.getRun(run.runId);
      if (terminal(current.state)) {
        const entries = await nativeHistory(db, { runId: run.runId });
        const messages = nativeMessages(entries);
        result.catalogGateFailure = {
          runId: run.runId,
          state: current.state,
          failureCode: current.failure?.code,
          tools: (await currentState()).tools,
          calls: callsIn(entries).map((call) => call.name),
          assistantErrors: messages
            .filter((message) => message.role === "assistant" && message.stopReason === "error")
            .map((message) => String(message.errorMessage ?? "Model error").slice(0, 500)),
          toolErrors: messages
            .filter((message) => message.role === "toolResult" && message.isError)
            .map((message) => ({
              name: message.toolName,
              // Owned synthetic gate only; retain bounded failure text before
              // lifecycle cleanup removes its native history.
              text: message.content
                .filter((part) => part.type === "text")
                .map((part) => part.text)
                .join("\n")
                .slice(0, 1500),
            })),
          sandboxErrors: kubectl(["logs", workload("control-plane"), "--since=2m", "--tail=1000"])
            .split("\n")
            .flatMap((line) => {
              try {
                const event = JSON.parse(line);
                return event.service === "pi-cloud-sandbox-control" &&
                  event.event === "operation_failed"
                  ? [
                      {
                        code: event.publicCode,
                        retryable: event.retryable,
                        diagnostic: event.diagnostic,
                      },
                    ]
                  : [];
              } catch {
                return [];
              }
            }),
          workspaceOwners: await db
            .selectFrom("workspace_runtimes as runtime")
            .leftJoin(
              "sandbox_control_instances as owner",
              "owner.instance_id",
              "runtime.owner_instance_id",
            )
            .select([
              "runtime.state",
              "runtime.failure_code",
              "runtime.updated_at",
              "runtime.owner_base_url",
              "owner.state as ownerState",
              "owner.lease_expires_at",
            ])
            .where("runtime.tenant_id", "=", tenant.tenantId)
            .where("runtime.workspace_id", "=", session.workspaceId)
            .execute(),
          currentControlPlanePods: JSON.parse(
            kubectl([
              "get",
              "pods",
              "-l",
              "app.kubernetes.io/component=control-plane",
              "-o",
              "json",
            ]),
          ).items.map((pod) => ({
            name: pod.metadata.name,
            ip: pod.status.podIP,
            deleting: Boolean(pod.metadata.deletionTimestamp),
          })),
        };
        await save(result);
        throw new Error("Catalog gate ended before replacement");
      }
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
    assert(!(await currentState()).tools.includes("preview"));
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
    assert((await currentState()).tools.includes("preview"));
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
    assert((await currentState()).tools.includes("preview"));
    const previous = await lease(removed);
    progress("runtime capabilities: withdraw preview during an active loop");
    await swap([]);
    assert.deepEqual(await lease(removed), previous);
    await releaseGate(removedGate);
    await finish(removed);
    assert(!(await currentState()).tools.includes("preview"));
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
  assert((await currentState()).tools.includes("preview"));
  result.deepseek = {
    model: "deepseek-v4-flash",
    selectedUltra: true,
    nativeToolCompleted: true,
    hostedSearchTested: false,
  };
  result.accepted = true;
  return result;
}
