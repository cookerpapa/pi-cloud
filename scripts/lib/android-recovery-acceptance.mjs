import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { sql } from "kysely";
import { runtimeDirectory, kubectl } from "./production-kubernetes.mjs";
import {
  installOwnedReplyFault,
  armOwnedReplyFault,
  disarmOwnedReplyFault,
  readOwnedReplyFault,
  restoreOwnedReplyFault,
} from "./live-tool-reply-fault.mjs";
import { nativeHistory, nativeMessages } from "./native-session-history.mjs";
import { newIdempotencyKey } from "../../packages/web-ui/src/api.ts";
const execute = promisify(execFile);
const terminal = (run) => ["completed", "failed", "cancelled", "timed_out"].includes(run.state);

/** Real readonly device actions, isolated by tenant+Session in the test-only
 * completion preload. No production fault flag or screenshot archive is added. */
export async function androidRecoveryAcceptance({ db, api, session, target, until, onRun }) {
  const receiptPath = `${runtimeDirectory}/android-reply-recovery-${randomUUID()}.json`;
  let receipt;
  const cases = [];
  const exclusive = async (runId) => {
    const { rows } =
      await sql`select count(*)::int as count from runs where state not in ('completed','failed','cancelled','timed_out') and id is distinct from ${runId ?? null}::uuid`.execute(
        db,
      );
    assert.equal(rows[0].count, 0, "An unrelated Run is active; do not replace its Worker");
  };
  const retired = () =>
    until(
      async () => {
        const { rows } =
          await sql`select 1 from session_leases where tenant_id=${target.tenant_id}::uuid and pi_session_id=(select pi_session_id from sessions where id=${session.sessionId}::uuid) and released_at is null limit 1`.execute(
            db,
          );
        return !rows.length;
      },
      "owned writer retirement",
      60000,
    );
  const devicePod = () => {
    const name = "pi-android-" + target.id.slice(0, 8);
    const pod = JSON.parse(
      kubectl(["get", "pods", "-l", "app.kubernetes.io/instance=" + name, "-o", "json"]),
    ).items.find(
      (p) =>
        !p.metadata.deletionTimestamp &&
        p.status.conditions?.some((c) => c.type === "Ready" && c.status === "True"),
    );
    assert(pod, "Owned Android receiver is unavailable");
    return pod;
  };
  const status = () => {
    const source = `const fs=await import('node:fs/promises');const token=(await fs.readFile(process.env.PI_CLOUD_SUPERVISOR_MANAGEMENT_TOKEN_FILE,'utf8')).trim();const r=await fetch('http://127.0.0.1:8090/health/ready',{headers:{authorization:'Bearer '+token}});if(!r.ok)throw Error('Receiver unavailable');console.log(JSON.stringify(await r.json()));`;
    return JSON.parse(
      kubectl([
        "exec",
        devicePod().metadata.name,
        "-c",
        "executor",
        "--",
        "node",
        "--input-type=module",
        "-e",
        source,
      ]),
    );
  };
  const kill = async (pod, name) => {
    const value = JSON.parse(kubectl(["get", "pod", pod, "-o", "json"]));
    const container = value.status.containerStatuses.find((c) => c.name === name);
    assert(/^containerd:\/\/[0-9a-f]{64}$/.test(container?.containerID ?? ""));
    await execute("/usr/local/bin/k3s", [
      "ctr",
      "-n",
      "k8s.io",
      "tasks",
      "kill",
      "--signal",
      "SIGKILL",
      container.containerID.slice("containerd://".length),
    ]);
  };
  try {
    await exclusive();
    await retired();
    try {
      receipt = await installOwnedReplyFault(receiptPath);
    } catch (error) {
      receipt = error.replyFaultReceipt;
      throw error;
    }
    for (const mode of ["worker", "stop", "receiver"]) {
      await retired();
      await exclusive();
      const beforeDevice = status();
      const nonce = armOwnedReplyFault(receipt, target.tenant_id, "", false, false, {
        sessionId: session.sessionId,
        toolName: "android_observe",
        defer: true,
      });
      const active = await api.acceptTurn(
        session.sessionId,
        "只调用一次 android_observe 查看当前屏幕。不要点击、输入、重试观察、使用其他工具或委派。收到结果后回复 ANDROID_RECOVERY_OK。",
        newIdempotencyKey("android-original-reply"),
        "low",
      );
      onRun(active);
      const arrived = await until(
        async () => {
          const state = readOwnedReplyFault(receipt);
          return state?.nonce === nonce && state.results?.length ? state : false;
        },
        "owned Android completion reached HTTPS",
        600000,
      );
      const operationId = arrived.results[0].operationId;
      assert.equal(new Set(arrived.results.map((r) => r.operationId)).size, 1);
      const source = async () => {
        const { rows } =
          await sql`select c.cloud_metadata from pi_durable_commits c where c.tenant_id=${target.tenant_id}::uuid and c.session_id=(select pi_session_id from sessions where id=${session.sessionId}::uuid) and c.cloud_metadata is not null order by c.seq desc limit 32`.execute(
            db,
          );
        for (const row of rows) {
          const value = JSON.parse(row.cloud_metadata).remoteTools?.find(
            (t) => t.operationId === operationId,
          );
          if (value) return value;
        }
      };
      const original = await until(source, "original native device reply reference");
      assert(
        original.replyRecovery.deadlineAt - Date.now() > 25000,
        "Too little original deadline remains for an honest fault check",
      );
      const before = await api.getRun(active.runId);
      assert(before.workerId && !terminal(before));
      await exclusive(active.runId);
      let replacementMs, afterStop;
      if (mode === "worker") {
        const {
          rows: [worker],
        } = await sql`select supervisor_id from workers where id=${before.workerId}::uuid`.execute(
          db,
        );
        const started = Date.now();
        await kill(worker.supervisor_id, "pi-worker");
        await until(
          async () => {
            const r = await api.getRun(active.runId);
            return r.workerId && r.workerId !== before.workerId ? r : false;
          },
          "replacement Worker",
          60000,
        );
        replacementMs = Date.now() - started;
        assert.deepEqual(
          (await source()).replyRecovery,
          original.replyRecovery,
          "Recovery changed the original reply/deadline",
        );
      } else if (mode === "stop") {
        await api.cancelTurn(session.sessionId, active.turnId, newIdempotencyKey("android-stop"));
        await until(
          async () => terminal(await api.getRun(active.runId)),
          "native abort settlement",
          60000,
        );
        afterStop = nativeMessages(await nativeHistory(db, { runId: active.runId })).filter(
          (m) => m.role === "toolResult",
        );
      } else {
        await kill(devicePod().metadata.name, "executor");
        await until(
          async () => {
            try {
              const s = status();
              return s.bootId !== beforeDevice.bootId ? s : false;
            } catch {
              return false;
            }
          },
          "receiver replacement",
          120000,
        );
      }
      disarmOwnedReplyFault(receipt);
      const finished = await until(
        async () => {
          const r = await api.getRun(active.runId);
          return terminal(r) ? r : false;
        },
        "original Android result settlement",
        180000,
      );
      if (mode === "receiver")
        assert.notEqual(
          finished.state,
          "completed",
          "A lost receiver result must remain unknown, not be replayed",
        );
      else
        assert.equal(
          finished.state,
          mode === "stop" ? "cancelled" : "completed",
          JSON.stringify(finished.failure),
        );
      await retired();
      await until(
        async () => {
          try {
            return !status().busy;
          } catch {
            return false;
          }
        },
        "receiver delivery settled",
        120000,
      );
      const messages = nativeMessages(await nativeHistory(db, { runId: active.runId }));
      const results = messages.filter((m) => m.role === "toolResult");
      const afterDevice = status();
      if (mode === "receiver") {
        assert.equal(afterDevice.operationsStarted, 0, "Receiver replacement replayed an action");
        assert.equal(
          (await source()).replyRecovery.deadlineAt,
          original.replyRecovery.deadlineAt,
          "Receiver loss reset the original deadline",
        );
      } else {
        assert.equal(afterDevice.bootId, beforeDevice.bootId);
        assert.equal(
          afterDevice.operationsStarted - beforeDevice.operationsStarted,
          1,
          "The device action was reexecuted",
        );
        if (mode === "stop")
          assert.deepEqual(results, afterStop, "A late physical result overwrote native abort");
        else {
          assert.equal(results.length, 1);
          assert.equal(results[0].toolName, "android_observe");
          assert.equal(results[0].isError, false);
        }
      }
      cases.push({
        mode,
        runId: active.runId,
        operationId,
        state: finished.state,
        replacementMs,
        originalDeadlineAt: original.replyRecovery.deadlineAt,
        noActionReplay: true,
      });
    }
    return { cases, passed: true };
  } finally {
    if (receipt?.pod)
      try {
        disarmOwnedReplyFault(receipt);
      } catch {}
    if (receipt) await restoreOwnedReplyFault(receiptPath);
  }
}
