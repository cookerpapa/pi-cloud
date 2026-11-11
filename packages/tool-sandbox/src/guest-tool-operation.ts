import { spawn, type ChildProcess } from "node:child_process";
import { constants } from "node:fs";
import { open, readFile, unlink, chmod } from "node:fs/promises";
import {
  parseToolWorkerInput,
  type ToolWorkerOutput,
  type GuestToolPreview,
} from "@pi-cloud/protocol/guest";
import { GuestCompletionClient } from "@pi-cloud/workspace-runtime/tool-completion-client";
import {
  GUEST_STATE,
  operationInput,
  operationSocket,
  listenGuestRpc,
  processStart,
} from "./guest-executor-ipc.ts";
import {
  enterExecutionCgroup,
  finishExecutionCgroup,
  stopExecutionCgroup,
} from "./execution-cgroup.ts";
import { GuestExecutorStore } from "./guest-executor-store.ts";
import { toolOutputFrames } from "./tool-output-frames.ts";

async function main() {
  if (process.getuid?.() !== 0) throw new Error("root required");
  process.umask(0o077);
  const id = process.argv[2]!,
    staged = JSON.parse(await readFile(operationInput(id), "utf8"));
  if (staged.operationId !== id) throw new Error("operation changed");
  const { delivery: destination, ...body } = staged.payload;
  const input = parseToolWorkerInput(body);
  if (input.type !== "worker.operation" || input.request.operationId !== id)
    throw new Error("operation changed");
  const kernel = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const store = new GuestExecutorStore(GUEST_STATE + "/state.sqlite", kernel);
  const delivery = new GuestCompletionClient(destination, id),
    request = input.request;
  let child: ChildProcess | undefined,
    cancelled = false,
    timedOut = false,
    finished = false,
    entered = false;
  const cancel = () => {
    cancelled = true;
    if (child?.stdin && !child.stdin.destroyed)
      child.stdin.write(JSON.stringify({ type: "worker.cancel", operationId: id }) + "\n");
  };
  const timeout = () => {
    if (finished) return;
    timedOut = true;
    child?.kill("SIGTERM");
  };
  const server = await listenGuestRpc(operationSocket(id), async (r: any) => {
    if (r?.operationId !== id || r.token !== staged.token) return { accepted: false };
    if (!finished) {
      if (r.action === "cancel") cancel();
      else if (r.action === "timeout") timeout();
    }
    return { accepted: true, finished };
  });
  await chmod(operationSocket(id), 0o600);
  const inputPath = `/tmp/pi-cloud-envd-${id}.json`;
  let final: ToolWorkerOutput | undefined;
  let timer: NodeJS.Timeout | undefined;
  const fail = (): ToolWorkerOutput => ({
    toolWorkerProtocolVersion: 7,
    type: "worker.failed",
    operationId: id,
    code: "tool_operation_outcome_unknown",
    message:
      "Guest execution ended without a confirmed result; inspect effects before repeating it.",
    retryable: false,
  });
  try {
    const claim = store.claim(id, staged.token, process.pid, processStart(process.pid)!);
    cancelled ||= !!claim.cancelled;
    timer = setTimeout(timeout, Math.max(1, claim.deadline - Date.now()));
    timer.unref();
    await enterExecutionCgroup(id, inputPath);
    entered = true;
    const file = await open(
      inputPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(JSON.stringify(input));
      await file.chown(1000, 1000);
      await file.chmod(0o400);
    } finally {
      await file.close();
    }
    if (timedOut || Date.now() >= claim.deadline) throw new Error("operation deadline elapsed");
    if (cancelled) {
      final = {
        toolWorkerProtocolVersion: 7,
        type: "worker.operation_result",
        scopeStopRequired: false,
        response: {
          toolBrokerProtocolVersion: 1,
          type: "tool_sandbox.operation_result",
          activationId: request.activationId,
          operationId: id,
          operation: "tool.execute",
          event: {
            type: "tool_execution_end",
            toolCallId: request.toolCallId,
            toolName: request.toolName,
            isError: true,
            result: { content: [{ type: "text", text: "Command aborted before execution" }] },
          },
        },
      };
    } else {
      child = spawn(
        "/usr/bin/setpriv",
        [
          "--reuid",
          "1000",
          "--regid",
          "1000",
          "--clear-groups",
          "--no-new-privs",
          process.execPath,
          "/opt/pi-cloud/bin/envd-tool-exec.mjs",
          inputPath,
        ],
        { detached: true, stdio: ["pipe", "pipe", "ignore"] },
      );
      child.stdin!.on("error", () => {});
      let outputFailed = false;
      const output = (async () => {
        for await (const frame of toolOutputFrames(child!.stdout!)) {
          const value = JSON.parse(frame) as ToolWorkerOutput | GuestToolPreview;
          if (value.type === "worker.preview") delivery.progress(value);
          else {
            if (final) throw new Error("duplicate final");
            final = value;
          }
        }
      })();
      void output.catch(() => {
        outputFailed = true;
        child?.kill("SIGTERM");
      });
      if (cancelled) cancel();
      if (timedOut) timeout();
      const code = await new Promise<number | null>((resolve, reject) => {
        child!.once("error", reject);
        child!.once("exit", resolve);
      });
      await output.catch(() => {});
      if (code !== 0 || outputFailed || !final) final = fail();
    }
    await finishExecutionCgroup(id);
    entered = false;
    if (
      timedOut ||
      !final ||
      final.type === "worker.failed" ||
      (final.type === "worker.operation_result" && final.scopeStopRequired)
    )
      await stopExecutionCgroup(id);
    finished = true;
    clearTimeout(timer);
    store.finish(id, staged.token);
    await delivery.complete(final ?? fail()).catch(() => {});
  } catch {
    child?.kill("SIGTERM");
    // Leave our own cgroup before fault cleanup. The fixed operation, not an
    // unrelated PID or whole VM, is the cleanup boundary.
    try {
      if (entered) await finishExecutionCgroup(id);
      await stopExecutionCgroup(id);
      finished = true;
    } catch {
      finished = false;
    }
    clearTimeout(timer);
    try {
      if (finished) store.finish(id, staged.token);
      else store.block();
    } catch {
      finished = false;
    }
    await delivery.complete(fail()).catch(() => {});
  } finally {
    clearTimeout(timer);
    child?.stdin?.destroy();
    await unlink(inputPath).catch(() => {});
    if (finished) {
      try {
        store.release(id, staged.token);
        await unlink(operationInput(id)).catch(() => {});
      } catch {
        // Finished metadata is sufficient for the service to reap safely later.
      }
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await unlink(operationSocket(id)).catch(() => {});
    store.close();
  }
}
void main().catch(() => {
  process.stderr.write("guest_operation_unavailable\n");
  process.exitCode = 1;
});
