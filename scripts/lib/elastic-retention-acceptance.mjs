import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { newIdempotencyKey } from "../../packages/web-ui/src/api.ts";
import { OfficialCubeSandboxRuntimeClient } from "../../packages/sandbox-control/src/cubesandbox-runtime-client.ts";
import { runtimeDirectory, kubectl, serviceAddress } from "./production-kubernetes.mjs";
import { armRuntimeRestore } from "./owned-runtime-outage.mjs";
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
  assert.equal(
    process.env.PI_CLOUD_RETENTION_CONTROL_OUTAGE,
    undefined,
    "Use PI_CLOUD_RETENTION_SESSION_RUNTIME_OUTAGE to stop the keepalive delivery path explicitly",
  );
  assert(
    [undefined, "0", "1"].includes(process.env.PI_CLOUD_RETENTION_SESSION_RUNTIME_OUTAGE),
    "Invalid Session-runtime retention outage selection",
  );
  const outageRequested = process.env.PI_CLOUD_RETENTION_SESSION_RUNTIME_OUTAGE === "1";
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
    sessionRuntimeOutage: false,
    outageRequested,
  };
  const abort = new AbortController();
  const interrupted = () => abort.abort(new Error("Retention acceptance interrupted"));
  process.on("SIGINT", interrupted);
  process.on("SIGTERM", interrupted);
  let outage;
  let managementBefore;
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
  const managementPods = () =>
    JSON.parse(
      kubectl(["get", "pods", "-l", "app.kubernetes.io/component=control-plane", "-o", "json"]),
    )
      .items.filter((pod) => !pod.metadata.deletionTimestamp)
      .map((pod) => ({
        uid: pod.metadata.uid,
        containers: pod.status.containerStatuses?.map((container) => ({
          name: container.name,
          id: container.containerID,
          ready: container.ready,
          restarts: container.restartCount,
        })),
      }))
      .sort((left, right) => left.uid.localeCompare(right.uid));
  const assertNoWork = async () => {
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
    assert.equal(active.length, 0, "Unfinished work prevents the Session-runtime outage fixture");
  };
  const restore = async () => {
    if (!outage) return;
    await outage.restore();
    await wait(
      async () => {
        try {
          return (
            await fetch(`http://${serviceAddress("session-runtime")}:3000/health/ready`, {
              signal: AbortSignal.timeout(2000),
            })
          ).ok;
        } catch {
          return false;
        }
      },
      "Session runtime restoration",
      180000,
      1000,
      false,
    );
    result.restoreRequired = false;
    outage = undefined;
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
      1800000,
      "Default-window evidence requires the actual 30-minute policy",
    );
    assert(initial.retainUntil > Date.now());
    result.initialRuntimeId = runtime.workspace_runtime_id;
    result.windowMs = initial.retentionWindowMs;
    await save(result);
    // Execution-side maintenance is periodic. Keep a real Run active across a
    // complete minute without sending another Tool call; a one-second chat need
    // not overlap its lease bucket and is not evidence of a periodic renewal.
    progress("retention: existing VM renewed while the same Tool is still pending");
    const waiting = await api.acceptTurn(
      session.sessionId,
      "只调用一次 bash，timeout 设为 150，command 精确为：printf waiting > /workspace/retention-waiting.txt; sleep 100; printf RETENTION_WAIT_OK。不要搜索、委派或其他工具。完成后简短回复。",
      newIdempotencyKey("retention-wait"),
      "low",
    );
    await wait(
      async () => {
        try {
          return (
            Buffer.from(
              (await api.readWorkspaceFile(session.sessionId, "/workspace/retention-waiting.txt"))
                .bytes,
            ).toString() === "waiting"
          );
        } catch {
          return false;
        }
      },
      "one pending guest command",
      120000,
    );
    const beforeMaintenance = await inspect();
    const renewed = await wait(
      async () => {
        const run = await api.getRun(waiting.runId);
        assert(
          !["completed", "failed", "cancelled", "timed_out"].includes(run.state),
          "Fixture ended before its periodic renewal",
        );
        const value = await inspect();
        return value.retainUntil > beforeMaintenance.retainUntil + 20000 && value;
      },
      "execution-owned retention renewal without another Tool",
      90000,
    );
    const history = await completed(waiting.runId);
    assert.equal(
      nativeMessages(history).filter((message) => message.role === "toolResult").length,
      1,
    );
    result.activeWaitRenewedWithoutNewTool = true;
    result.renewedUntil = renewed.retainUntil;
    await save(result);
    if (outageRequested) {
      await assertNoWork();
      managementBefore = managementPods();
      assert(
        managementBefore.length &&
          managementBefore.every((pod) => pod.containers?.every((container) => container.ready)),
        "Management must remain ready while the keepalive delivery path is stopped",
      );
      const restorePath = `${runtimeDirectory}/retention-session-runtime-${randomUUID()}.restore.json`;
      outage = await armRuntimeRestore(
        "session-runtime",
        restorePath,
        renewed.retainUntil + 300000,
      );
      assert.equal(
        outage.receipt.replicas,
        1,
        "This fixture uses one Session-runtime replica without an HPA",
      );
      result.restoreRequired = true;
      result.restoreReplicas = outage.receipt.replicas;
      result.restoreReceipt = restorePath;
      await save(result);
      progress(
        "retention: Session Projector offline; management stays ready while Cube owns idle expiry",
      );
      kubectl(
        ["scale", "deployment/pi-cloud-session-runtime", "--current-replicas=1", "--replicas=0"],
        { timeout: 15000 },
      );
      await wait(
        () =>
          JSON.parse(kubectl(["get", "pods", "-l", outage.selector, "-o", "json"])).items.length ===
          0,
        "Session-runtime Pods absent",
        90000,
      );
      assert.deepEqual(
        managementPods(),
        managementBefore,
        "Stopping Session runtime changed management",
      );
      result.sessionRuntimeOutage = true;
      result.managementStayedAvailable = true;
      await save(result);
    }
    progress("retention: waiting for the real 30-minute idle expiry");
    const idleStart = Date.now();
    await wait(
      async () => {
        if (outage) await assertNoWork();
        const state = await inspect();
        if (!state.closed || state.phase !== "absent") return false;
        assert(Date.now() >= renewed.retainUntil, "Compute expired before its accepted deadline");
        return true;
      },
      "Cube-owned idle expiry",
      1980000,
      5000,
    );
    result.idleWaitMs = Date.now() - idleStart;
    result.expiredAt = new Date().toISOString();
    result.cubeClosedAndConfirmedAbsent = true;
    if (outage) {
      assert.equal(
        JSON.parse(kubectl(["get", "pods", "-l", outage.selector, "-o", "json"])).items.length,
        0,
        "Session runtime returned before the Cube-owned expiry observation",
      );
      assert.deepEqual(
        managementPods(),
        managementBefore,
        "Management changed during the keepalive-path outage",
      );
      const managementHealth = await fetch(
        `http://${serviceAddress("control-plane")}:3000/health/ready`,
        { signal: AbortSignal.timeout(2000) },
      );
      assert(managementHealth.ok, "Management was not available at confirmed Cube expiry");
      result.managementStayedAvailable = true;
    }
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
