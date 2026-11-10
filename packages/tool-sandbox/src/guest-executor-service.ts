import { mkdir, readFile, unlink, open, chmod } from "node:fs/promises";
import { constants } from "node:fs";
import { spawn } from "node:child_process";
import {
  GUEST_STATE,
  GUEST_SOCKET,
  operationInput,
  operationSocket,
  guestRpc,
  listenGuestRpc,
  processStart,
} from "./guest-executor-ipc.ts";
import { GuestExecutorStore, type GuestOperation } from "./guest-executor-store.ts";
import { GuestCompletionClient } from "./completion-client.ts";
import { stopExecutionCgroup } from "./execution-cgroup.ts";
import {
  parseToolWorkerInput,
  parseToolCompletionDestination,
  guestUuid,
  type GuestSubmit,
  type GuestCancel,
} from "@pi-cloud/protocol/guest";

const refused = (code: string) => ({ accepted: false, rejection: code });
const safeCodes = new Set([
  "invalid_request",
  "invalid_identity",
  "invalid_scope",
  "invalid_execution_position",
  "operation_changed",
  "operation_unavailable",
  "execution_position_stale",
  "execution_stream_changed",
  "executor_replaced",
  "runtime_quarantined",
  "capacity",
]);
async function main() {
  if (process.getuid?.() !== 0) throw new Error("Guest service requires root");
  process.umask(0o077);
  await mkdir(GUEST_STATE + "/operations", { recursive: true, mode: 0o700 });
  const kernel = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const store = new GuestExecutorStore(GUEST_STATE + "/state.sqlite", kernel);
  if (
    !store.own(process.pid, processStart(process.pid)!, (pid, start) => processStart(pid) === start)
  ) {
    store.close();
    return;
  }
  await unlink(GUEST_SOCKET).catch((e) => {
    if (e.code !== "ENOENT") throw e;
  });
  const calls = new Set<Promise<unknown>>();
  const remove = async (o: GuestOperation) => {
    store.finish(o.id, o.token);
    store.release(o.id, o.token);
    await unlink(operationInput(o.id)).catch(() => {});
    await unlink(operationSocket(o.id)).catch(() => {});
  };
  const control = async (o: GuestOperation, action: "cancel" | "timeout") =>
    guestRpc(operationSocket(o.id), { action, operationId: o.id, token: o.token }).catch(
      () => undefined,
    );
  const unknown = async (o: GuestOperation) => {
    const input = JSON.parse(await readFile(operationInput(o.id), "utf8"));
    await new GuestCompletionClient(input.payload.delivery, o.id)
      .complete({
        toolWorkerProtocolVersion: 7,
        type: "worker.failed",
        operationId: o.id,
        code: "tool_operation_outcome_unknown",
        message:
          "Guest execution ended without a confirmed result; inspect effects before repeating it.",
        retryable: false,
      })
      .catch(() => {});
  };
  let sweeping = false;
  const sweep = async () => {
    if (sweeping) return;
    sweeping = true;
    try {
      for (let o of store.list()) {
        const alive = o.pid !== null && processStart(o.pid) === o.start;
        if (alive) {
          if (Date.now() >= o.deadline && !o.finished) {
            const reply = await control(o, "timeout");
            // A live PID is not proof that its control loop can enforce the
            // original deadline. Isolate this Guest; never kill by a reused PID
            // or manufacture a confirmed stop. Resource expiry remains finite.
            if (reply?.accepted !== true) store.block();
          }
          continue;
        }
        if (o.pid === null && Date.now() < o.deadline) continue; // Never replay an ambiguous launch.
        // The operation may have committed completion after list(), immediately
        // before exiting. Re-read after proving that the registered process died.
        // An old snapshot must never turn completed background work into cleanup.
        const latest = store.get(o.id);
        if (!latest || latest.token !== o.token || latest.pid !== o.pid || latest.start !== o.start)
          continue;
        o = latest;
        if (!o.finished) {
          try {
            await stopExecutionCgroup(o.id);
          } catch {
            store.block();
            continue;
          }
          await unknown(o).catch(() => {});
        }
        await remove(o);
      }
    } finally {
      sweeping = false;
    }
  };
  const server = await listenGuestRpc(GUEST_SOCKET, async (r: any) => {
    try {
      if (!r || r.version !== 1) return refused("invalid_request");
      if (r.action === "info")
        return {
          version: 1,
          bootId: store.bootId,
          guestBootId: kernel,
          runtimeBlocked: store.blocked,
        };
      store.assertBoot(r.bootId, r.action !== "cancel");
      if (r.action === "probe") {
        if (!guestUuid(r.probeId)) return refused("invalid_identity");
        const output = { type: "worker.probe_result", probeId: r.probeId, guestBootId: kernel };
        if (!r.delivery) return { accepted: true, bootId: store.bootId, output };
        if (calls.size >= 16) return refused("capacity");
        const delivery = new GuestCompletionClient(r.delivery, r.probeId);
        const work = delivery
          .complete(output)
          .catch(() => {})
          .finally(() => calls.delete(work));
        calls.add(work);
        return { accepted: true, bootId: store.bootId };
      }
      if (r.action === "cancel") {
        const matched = store.cancel(r as GuestCancel);
        await Promise.allSettled(matched.map((o) => control(o, "cancel")));
        return { accepted: true, bootId: store.bootId };
      }
      if (r.action !== "submit" || !r.payload) return refused("invalid_request");
      const { delivery, ...tool } = r.payload;
      const parsed = parseToolWorkerInput(tool),
        destination = parseToolCompletionDestination(delivery);
      if (parsed.type !== "worker.operation" || parsed.request.operationId !== r.operationId)
        return refused("invalid_identity");
      const admitted = store.admit(r as GuestSubmit, destination.expiresAt),
        o = admitted.operation;
      if (!admitted.fresh) return { accepted: true, bootId: store.bootId, operationId: o.id };
      let staged = false;
      try {
        const file = await open(
          operationInput(o.id),
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
        staged = true;
        try {
          await file.writeFile(
            JSON.stringify({
              operationId: o.id,
              token: o.token,
              deadline: o.deadline,
              payload: r.payload,
            }),
          );
          await file.sync();
        } finally {
          await file.close();
        }
        const child = spawn(
          process.execPath,
          ["/opt/pi-cloud/bin/guest-tool-operation.mjs", o.id],
          { cwd: "/", detached: true, stdio: "ignore" },
        );
        await new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", reject);
        });
        child.unref();
      } catch {
        if (staged) await unlink(operationInput(o.id)).catch(() => {});
        store.finish(o.id, o.token);
        store.release(o.id, o.token);
        return refused("execution_not_started");
      }
      return { accepted: true, bootId: store.bootId, operationId: o.id };
    } catch (e) {
      const code = e instanceof Error ? e.message : "";
      return refused(safeCodes.has(code) ? code : "handoff_unconfirmed");
    }
  });
  await chmod(GUEST_SOCKET, 0o600);
  const timer = setInterval(() => void sweep().catch(() => store.block()), 5000);
  timer.unref();
  const close = () => {
    clearInterval(timer);
    server.close(() => {
      store.close();
      process.exit(0);
    });
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  void sweep().catch(() => store.block());
}
void main().catch(() => {
  process.stderr.write("guest_executor_unavailable\n");
  process.exitCode = 1;
});
