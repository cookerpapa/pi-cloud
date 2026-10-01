import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import {
  enterExecutionCgroup,
  finishExecutionCgroup,
  stopExecutionCgroup,
} from "./execution-cgroup.ts";

async function* frames(): AsyncGenerator<string> {
  let pending = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    if (pending.length > 16 * 1024 * 1024) throw new Error("Execution scope input too large");
    let end: number;
    while ((end = pending.indexOf(10)) >= 0) {
      const frame = pending.subarray(0, end).toString("utf8");
      pending = pending.subarray(end + 1);
      yield frame;
    }
  }
  throw new Error("Execution scope input closed");
}

/** Fixed trusted guest boundary. Receives one bounded JSON payload on a raw PTY;
 * untrusted files and shell commands begin only inside their kernel scope. */
async function main(): Promise<void> {
  const [mode, operationId] = process.argv.slice(2);
  if (!process.stdin.isTTY) throw new Error("Native raw execution terminal required");
  process.stdin.setRawMode(true);
  const inputFrames = frames();
  const receipt = async () => {
    const deadline = setTimeout(
      () => process.stdin.destroy(new Error("Execution receipt expired")),
      5000,
    );
    try {
      if ((await inputFrames.next()).value !== '{"type":"scope.received"}')
        throw new Error("Execution receipt required");
    } finally {
      clearTimeout(deadline);
      process.stdin.destroy();
    }
  };
  process.stdout.write('{"type":"scope.ready"}\n');
  if (!operationId) throw new Error("Execution scope identity required");
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
    input.mode !== "operation" ||
    input.operation?.operation !== "tool.execute" ||
    input.operation.operationId !== operationId
  )
    throw new Error("Execution scope input identity changed");
  const inputPath = `/tmp/pi-cloud-envd-${operationId.toLowerCase()}.json`;
  await enterExecutionCgroup(operationId, inputPath);
  const file = await open(
    inputPath,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(body);
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
    { stdio: ["ignore", "inherit", "ignore"] },
  );
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
    process.exitCode = status;
    await unlink(inputPath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await finishExecutionCgroup(operationId);
    if (status === 0) await receipt();
  } finally {
    process.removeListener("SIGTERM", forward);
    process.removeListener("SIGINT", forward);
    await unlink(inputPath).catch(() => {});
  }
}

void main()
  .catch(() => {
    // Payloads may contain user material. The executor receives a bounded failure,
    // never an exception dump of the command or initialization envelope.
    process.stderr.write("cube_execution_scope_failed\n");
    process.exitCode = 1;
  })
  .finally(() => process.stdin.destroy());
