import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, readFile, unlink } from "node:fs/promises";
import { parseGuestToolPreview, type ToolWorkerOutput } from "@pi-cloud/protocol/guest";
import { GuestCompletionClient } from "./completion-client.ts";
import { toolOutputFrames } from "./tool-output-frames.ts";
import { ScopeReceiptTransportError, settledScopeReceipt } from "./scope-receipt.ts";
import {
  enterExecutionCgroup,
  finishExecutionCgroup,
  stopExecutionCgroup,
} from "./execution-cgroup.ts";

async function* frames(): AsyncGenerator<string> {
  let pending = Buffer.alloc(0);
  const input = process.stdin[Symbol.asyncIterator]();
  while (true) {
    let next: IteratorResult<Buffer>;
    try {
      next = await input.next();
    } catch {
      throw new ScopeReceiptTransportError();
    }
    if (next.done) {
      if (pending.length) throw new Error("Incomplete execution control frame");
      throw new ScopeReceiptTransportError();
    }
    const chunk = next.value;
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    if (pending.length > 16 * 1024 * 1024) throw new Error("Execution scope input too large");
    let end: number;
    while ((end = pending.indexOf(10)) >= 0) {
      const frame = pending.subarray(0, end).toString("utf8");
      pending = pending.subarray(end + 1);
      yield frame;
    }
  }
}

/** Fixed trusted guest boundary. Receives one bounded JSON payload on a raw PTY;
 * untrusted files and shell commands begin only inside their kernel scope. */
async function main(): Promise<void> {
  // A dead API reader must not terminate a finalized HTTP delivery. The scope
  // still obeys explicit cancellation and the Tool's own execution timeout.
  process.stdout.on("error", () => {});
  const [mode, operationId] = process.argv.slice(2);
  if (!process.stdin.isTTY) throw new Error("Native raw execution terminal required");
  process.stdin.setRawMode(true);
  const inputFrames = frames();
  const receipt = async () => {
    try {
      process.exitCode = await settledScopeReceipt(
        inputFrames.next().then(({ value }) => {
          if (value !== '{"type":"scope.received"}') throw new Error("Execution receipt required");
        }),
      );
    } finally {
      process.stdin.destroy();
    }
  };
  process.stdout.write('{"type":"scope.ready"}\n');
  if (!operationId) throw new Error("Execution scope identity required");
  if (mode === "probe") {
    const deadline = setTimeout(
      () => process.stdin.destroy(new Error("Execution probe expired")),
      5000,
    );
    try {
      const input = JSON.parse((await inputFrames.next()).value ?? "");
      if (
        !/^[0-9a-f-]{36}$/.test(operationId) ||
        input.probeId !== operationId ||
        input.mode !== "probe" ||
        Object.keys(input).some((key) => !["probeId", "mode", "delivery"].includes(key))
      )
        throw new Error("Execution probe identity changed");
      const guestBootId = (await readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
      const result = { type: "worker.probe_result", probeId: operationId, guestBootId };
      if (input.delivery) {
        clearTimeout(deadline);
        const delivery = new GuestCompletionClient(input.delivery, operationId);
        let delivered = true;
        await delivery.complete(result).catch(() => {
          delivered = false;
        });
        process.stdout.write(
          JSON.stringify({
            type: "worker.delivery_result",
            toolWorkerProtocolVersion: 7,
            operationId,
            executionComplete: true,
            delivered,
          }) + "\n",
        );
      } else {
        // The resource owner's synchronous physical observation is deliberately
        // separate from the full Guest → HTTPS → Kafka → Worker path.
        process.stdout.write(JSON.stringify(result) + "\n");
        await receipt();
      }
    } finally {
      clearTimeout(deadline);
    }
    return;
  }
  if (mode === "stop") {
    const result = await stopExecutionCgroup(operationId);
    if (result.inputPath) await unlink(result.inputPath).catch(() => {});
    process.stdout.write(JSON.stringify({ type: "scope.stop_result", empty: result.empty }) + "\n");
    await receipt();
    return;
  }
  if (mode !== "run") throw new Error("Unknown execution scope action");
  const body = Buffer.from((await inputFrames.next()).value ?? "");
  const input = JSON.parse(body.toString("utf8"));
  if (
    input.toolWorkerProtocolVersion !== 7 ||
    input.type !== "worker.operation" ||
    input.request?.operation !== "tool.execute" ||
    input.request.operationId !== operationId
  )
    throw new Error("Execution scope input identity changed");
  const delivery = new GuestCompletionClient(input.delivery, operationId);
  if (delivery.destination.expiresAt <= Date.now())
    throw new Error("Execution delivery already expired");
  delete input.delivery; // The untrusted uid-1000 Tool never receives this capability.
  const hangup = () => {};
  process.on("SIGHUP", hangup);
  const inputPath = `/tmp/pi-cloud-envd-${operationId.toLowerCase()}.json`;
  await enterExecutionCgroup(operationId, inputPath);
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
  const child = spawn(
    "/usr/bin/setpriv",
    [
      "--reuid",
      "1000",
      "--regid",
      "1000",
      "--clear-groups",
      "--no-new-privs",
      "/usr/local/bin/node",
      "/opt/pi-cloud/bin/envd-tool-exec.mjs",
      inputPath,
    ],
    // A lost provider PTY can send SIGHUP to its foreground process group.
    // The fixed child has its own session; cancellation still uses our stdin
    // channel and fault cleanup still addresses the inherited cgroup.
    { stdio: ["pipe", "pipe", "ignore"], detached: true },
  );
  child.stdin.on("error", () => {
    /* A final result may race cancellation. */
  });
  let final: ToolWorkerOutput | undefined;
  const output = (async () => {
    for await (const frame of toolOutputFrames(child.stdout)) {
      const value = JSON.parse(frame) as ToolWorkerOutput | { type: "worker.preview" };
      if (value.type === "worker.preview") delivery.progress(parseGuestToolPreview(value));
      else {
        if (final) throw new Error("Guest produced two terminal frames");
        final = value;
      }
    }
  })();
  let outputFailed = false;
  void output.catch(() => {
    outputFailed = true;
    child.kill("SIGTERM");
  });
  const received = Promise.withResolvers<void>();
  let scopeSettled = false,
    controlFault = false;
  const control = (async () => {
    for await (const frame of inputFrames) {
      if (frame === '{"type":"scope.received"}') {
        received.resolve();
        return;
      }
      const message = JSON.parse(frame);
      if (
        message.type !== "scope.cancel" ||
        message.operationId !== operationId ||
        Object.keys(message).length !== 2
      )
        throw new Error("Invalid execution control frame");
      if (!child.stdin.destroyed)
        child.stdin.write(JSON.stringify({ type: "worker.cancel", operationId }) + "\n");
    }
  })();
  void control.catch((error) => {
    received.reject(error);
    if (!(error instanceof ScopeReceiptTransportError) && !scopeSettled) {
      controlFault = true;
      child.kill("SIGTERM");
    }
  });
  void received.promise.catch(() => {});
  const forward = () => {
    child.kill("SIGTERM");
  };
  process.on("SIGTERM", forward);
  process.on("SIGINT", forward);
  try {
    const status = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
    await output.catch(() => {
      outputFailed = true;
    });
    // The receipt-only code belongs to this launcher, never to its child.
    process.exitCode = status === 0 ? 0 : 1;
    await unlink(inputPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await finishExecutionCgroup(operationId);
    const stopRequired =
      status !== 0 ||
      outputFailed ||
      controlFault ||
      !final ||
      (final.type === "worker.operation_result" && final.scopeStopRequired);
    if (stopRequired) await stopExecutionCgroup(operationId);
    scopeSettled = true;
    // Separate physical execution settlement from callback delivery. Losing the
    // HTTPS ACK must not retroactively kill an already-started background server.
    process.stdout.write(JSON.stringify({ type: "scope.executed", operationId }) + "\n");
    let delivered = true;
    await delivery
      .complete(
        status === 0 && !outputFailed && !controlFault && final
          ? final
          : {
              toolWorkerProtocolVersion: 7,
              type: "worker.failed",
              code: "tool_operation_outcome_unknown",
              message:
                "Guest execution ended without a valid final result; inspect effects before repeating it.",
              retryable: false,
            },
      )
      .catch(() => {
        delivered = false;
      });
    // Cube receives only a small delivery receipt; it never receives image bytes.
    process.stdout.write(
      JSON.stringify({
        type: "worker.delivery_result",
        toolWorkerProtocolVersion: 7,
        operationId,
        delivered,
        executionComplete: true,
      }) + "\n",
    );
    process.exitCode = 0;
  } finally {
    process.removeListener("SIGTERM", forward);
    process.removeListener("SIGINT", forward);
    process.removeListener("SIGHUP", hangup);
    child.stdin.destroy();
    await unlink(inputPath).catch(() => {});
  }
}

void main()
  .catch(() => {
    // Payloads may contain user material. The executor receives a bounded failure,
    // never an exception dump of the command or attachment payload.
    process.stderr.write("cube_execution_scope_failed\n");
    process.exitCode = 1;
  })
  .finally(() => process.stdin.destroy());
