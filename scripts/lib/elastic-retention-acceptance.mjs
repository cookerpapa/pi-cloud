import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { newIdempotencyKey } from "../../packages/web-ui/src/api.ts";
import { OfficialCubeSandboxRuntimeClient } from "../../packages/sandbox-control/src/cubesandbox-runtime-client.ts";
import { runtimeDirectory, kubectl, serviceAddress } from "./production-kubernetes.mjs";
import { nativeMessages } from "./native-session-history.mjs";

/** Owned real-model/VM fixture. Uses the configured window, never changes it. */
export async function elasticRetentionAcceptance({
  database,
  api,
  tenant,
  session,
  completed,
  progress,
  save,
}) {
  const cluster = JSON.parse(
    await readFile(runtimeDirectory + "/cubesandbox/cluster.json", "utf8"),
  );
  const cube = new OfficialCubeSandboxRuntimeClient({
    apiUrl: `http://${cluster.api.host}:${cluster.api.port}`,
    apiKey: (await readFile(runtimeDirectory + "/secrets/cubesandbox-api-key", "utf8")).trim(),
    proxyNodeIp: cluster.proxy.host,
    proxyPort: cluster.proxy.port,
    proxyScheme: "http",
    sandboxDomain: cluster.sandboxDomain,
    egressProxyIp: "10.255.255.254",
    requestTimeoutMs: 10000,
  });
  const result = {
    startedAt: new Date().toISOString(),
    accepted: false,
    controlPlaneOutage: false,
  };
  const abort = new AbortController();
  const interrupted = () => abort.abort(new Error("Retention acceptance interrupted"));
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  let replicas;
  const wait = async (read, label, budget, interval = 1000, cancellable = true) => {
    const end = Date.now() + budget;
    while (Date.now() < end) {
      if (cancellable) abort.signal.throwIfAborted();
      const value = await read();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new Error(label + " timed out");
  };
  const current = async () =>
    database
      .selectFrom("workspace_runtimes")
      .select(["workspace_runtime_id", "runtime_name", "creation_not_after", "state"])
      .where("tenant_id", "=", tenant.tenantId)
      .where("workspace_id", "=", session.workspaceId)
      .where("compute_session_id", "is", null)
      .where("allocation_closed", "=", false)
      .where("state", "in", ["allocated"])
      .where("runtime_name", "is not", null)
      .executeTakeFirst();
  const restore = async () => {
    if (replicas === undefined) return;
    kubectl(["scale", "deployment/pi-cloud-control-plane", `--replicas=${replicas}`], {
      timeout: 15000,
    });
    await wait(
      async () => {
        try {
          return (
            await fetch(`http://${serviceAddress("control-plane")}:3000/health/ready`, {
              signal: AbortSignal.timeout(2000),
            })
          ).ok;
        } catch {
          return false;
        }
      },
      "Control Plane restoration",
      180000,
      1000,
      false,
    );
    result.restoreRequired = false;
    replicas = undefined;
    await save(result);
  };
  try {
    progress("retention: create owned file with Luna");
    const marker = "RETENTION_" + randomUUID().replaceAll("-", "");
    const command = `printf '%s' '${marker}' > /workspace/retention-proof.txt`;
    const first = await api.acceptTurn(
      session.sessionId,
      `只调用一次 bash，command 精确使用以下 JSON 字符串：${JSON.stringify(command)}。不要搜索、委派或启动后台服务。完成后回复 FILE_READY。`,
      newIdempotencyKey("retention-file"),
      "low",
    );
    await completed(first.runId);
    const runtime = await wait(current, "retention fixture runtime", 30000);
    const deadline = new Date(runtime.creation_not_after).valueOf();
    const inspect = () => cube.allocation(runtime.workspace_runtime_id, deadline, "get");
    const initial = await inspect();
    assert.equal(
      initial.retentionWindowMs,
      900000,
      "Default-window evidence requires the actual 15-minute policy",
    );
    assert(initial.retainUntil > Date.now());
    result.initialRuntimeId = runtime.workspace_runtime_id;
    result.windowMs = initial.retentionWindowMs;
    await save(result);
    // Allow coalescing to become due so this short, no-Tool turn proves initial
    // keepalive delivery even if it finishes before the next 15-second tick.
    progress("retention: existing VM renewed by a pure-chat task");
    await new Promise((resolve) => setTimeout(resolve, 31000));
    const chat = await api.acceptTurn(
      session.sessionId,
      "不要调用任何工具，只回复 RETENTION_CHAT_OK。",
      newIdempotencyKey("retention-chat"),
      "low",
    );
    const history = await completed(chat.runId);
    assert(!nativeMessages(history).some((message) => message.role === "toolResult"));
    const renewed = await wait(
      async () => {
        const value = await inspect();
        return value.retainUntil > initial.retainUntil + 20000 && value;
      },
      "pure-chat retention renewal",
      45000,
    );
    result.pureChatRenewedExistingVm = true;
    result.renewedUntil = renewed.retainUntil;
    await save(result);
    if (process.env.PI_CLOUD_RETENTION_CONTROL_OUTAGE === "1") {
      const active = await database
        .selectFrom("runs")
        .select("id")
        .where((eb) =>
          eb.or([
            eb("state", "not in", ["completed", "failed", "cancelled", "timed_out"]),
            eb("recovery_requested_at", "is not", null),
            eb.and([eb("output_seal_id", "is not", null), eb("output_sealed_at", "is", null)]),
          ]),
        )
        .limit(1)
        .execute();
      assert.equal(active.length, 0, "Unfinished work prevents the Control Plane outage fixture");
      replicas = JSON.parse(kubectl(["get", "deployment/pi-cloud-control-plane", "-o", "json"]))
        .spec.replicas;
      assert.equal(
        replicas,
        1,
        "This live outage fixture targets the maintained single-controller installation",
      );
      result.restoreRequired = true;
      result.restoreReplicas = replicas;
      await save(result);
      progress("retention: Control Plane offline; Cube must expire compute independently");
      kubectl(["scale", "deployment/pi-cloud-control-plane", "--replicas=0"], { timeout: 15000 });
      result.controlPlaneOutage = true;
      await save(result);
    }
    progress("retention: waiting for the real 15-minute idle expiry");
    const idleStart = Date.now();
    await wait(
      async () => {
        const state = await inspect();
        if (!state.closed || state.phase !== "absent") return false;
        assert(Date.now() >= renewed.retainUntil, "Compute expired before its accepted deadline");
        return true;
      },
      "Cube-owned idle expiry",
      1080000,
      5000,
    );
    result.idleWaitMs = Date.now() - idleStart;
    result.expiredAt = new Date().toISOString();
    result.cubeClosedAndConfirmedAbsent = true;
    await save(result);
    await restore();
    await wait(
      async () =>
        (
          await database
            .selectFrom("workspace_runtimes")
            .select("state")
            .where("tenant_id", "=", tenant.tenantId)
            .where("workspace_runtime_id", "=", runtime.workspace_runtime_id)
            .executeTakeFirst()
        )?.state === "released",
      "Control Plane adopts Cube expiry",
      120000,
    );
    progress("retention: Luna continues on a new VM with the existing Workspace");
    const next = await api.acceptTurn(
      session.sessionId,
      "只调用一次 read，读取 /workspace/retention-proof.txt，然后原样回复文件内容。不要搜索、委派、创建或修改文件。",
      newIdempotencyKey("retention-reopen"),
      "low",
    );
    const resumed = await completed(next.runId);
    assert(
      nativeMessages(resumed).some(
        (message) =>
          message.role === "toolResult" &&
          message.toolName === "read" &&
          !message.isError &&
          message.content?.some((part) => part.type === "text" && part.text.includes(marker)),
      ),
      "A successful native Read must confirm the retained file bytes",
    );
    result.toolReadConfirmed = true;
    const answer = nativeMessages(resumed)
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.content ?? [])
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    assert(answer.includes(marker), "Workspace file bytes did not survive expiry");
    assert(
      resumed.some((row) => row.entry.kind === "pi-cloud.sandbox_reset"),
      "Continuation must inform Pi that the physical runtime changed",
    );
    result.modelSawRuntimeChange = true;
    const replacement = await wait(current, "replacement runtime", 30000);
    assert.notEqual(replacement.workspace_runtime_id, runtime.workspace_runtime_id);
    result.replacementRuntimeId = replacement.workspace_runtime_id;
    result.workspacePreserved = true;
    result.accepted = true;
    await save(result);
    return result;
  } finally {
    try {
      await restore();
    } finally {
      process.off("SIGINT", interrupted);
      process.off("SIGTERM", interrupted);
      await cube.close();
    }
  }
}
