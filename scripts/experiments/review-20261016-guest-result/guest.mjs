// Baseline characterization only: this asserts defects, not repaired behavior.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const exec = promisify(execFile);
assert.equal(process.getuid?.(), 1000, "The isolated guest fixture requires UID 1000");
const root = fileURLToPath(new URL("../../../", import.meta.url));
const directory = resolve(process.argv[2]);
await mkdir(directory, { recursive: true });
const guest = join(root, "packages/tool-sandbox/src/envd-tool-exec.ts");
const loader = join(root, "node_modules/tsx/dist/loader.mjs");
const inputs = [];
const evidence = { progress: [], receipts: [] };
async function input(command) {
  const operationId = randomUUID(),
    activationId = randomUUID();
  const payload = {
    toolWorkerProtocolVersion: 6,
    type: "worker.operation",
    attachment: { activationId, toolRoot: directory },
    request: {
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.operation",
      operation: "tool.execute",
      activationId,
      operationId,
      toolCallId: "review-call",
      toolName: "bash",
      args: { command },
      timeoutMs: 20000,
      maximumOutputBytes: 51200,
    },
  };
  const path = `/tmp/pi-cloud-envd-${operationId}.json`;
  inputs.push(path);
  return { path, payload, operationId };
}
try {
  for (const [name, count] of [
    ["small", 1024],
    ["truncated", 61440],
  ]) {
    const f = await input(`head -c ${count} /dev/zero | tr '\\0' x; sleep 1.5`);
    await writeFile(f.path, JSON.stringify(f.payload), { mode: 0o600 });
    const { stdout } = await exec(process.execPath, ["--import", loader, guest, f.path], {
      cwd: root,
      timeout: 15000,
      maxBuffer: 2 * 1024 * 1024,
    });
    const lines = stdout.trim().split("\n");
    const progress = lines.filter(
      (line) => JSON.parse(line).event?.type === "tool_execution_update",
    );
    assert(progress.length > 0);
    const frame = progress[0],
      value = JSON.parse(frame);
    const result = JSON.parse(lines.at(-1));
    assert.equal(result.response.event.isError, false);
    await writeFile(join(directory, `${name}-progress.json`), frame);
    evidence.progress.push({
      case: name,
      frameBytes: Buffer.byteLength(frame),
      visibleTextBytes: Buffer.byteLength(value.event.partialResult.content[0].text),
      duplicateTextBytes: Buffer.byteLength(
        value.event.partialResult.details?.truncation?.content ?? "",
      ),
      fitsNativeProgressLimit: Buffer.byteLength(frame) <= 65536,
      finalSucceeded: true,
    });
  }
  assert(evidence.progress[0].fitsNativeProgressLimit);
  assert(!evidence.progress[1].fitsNativeProgressLimit);

  // Exercise the actual launcher and Tool on a real local PTY, without root or
  // cgroup mutation. Only privilege launch and cgroup calls are substituted.
  const source = await readFile(join(root, "packages/tool-sandbox/src/cube-tool-scope.ts"), "utf8");
  const launch = /spawn\(\s*"\/usr\/bin\/setpriv",\s*\[[\s\S]*?inputPath,\s*\],/;
  assert.equal((source.match(new RegExp(launch.source, "g")) ?? []).length, 1);
  const transformed = source.replace(
    launch,
    `spawn(process.execPath, ["--import", ${JSON.stringify(loader)}, ${JSON.stringify(guest)}, inputPath],`,
  );
  const scope = join(directory, "scope.mjs");
  await build({
    stdin: {
      contents: transformed,
      resolveDir: join(root, "packages/tool-sandbox/src"),
      loader: "ts",
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outfile: scope,
    plugins: [
      {
        name: "isolated-cgroup",
        setup(b) {
          b.onResolve({ filter: /execution-cgroup\.ts$/ }, () => ({
            path: "cgroup",
            namespace: "review",
          }));
          b.onLoad({ filter: /.*/, namespace: "review" }, () => ({
            contents: `
        import {writeFile} from 'node:fs/promises';
        export async function enterExecutionCgroup() {}
        export async function finishExecutionCgroup() {
          await writeFile(process.env.REVIEW_FINISHED, 'finished');
        }
        export async function stopExecutionCgroup() { return {empty: true}; }
      `,
          }));
        },
      },
    ],
  });
  for (const acknowledge of [true, false]) {
    const f = await input("printf review-complete");
    const payloadPath = join(directory, `payload-${acknowledge}.json`);
    await writeFile(payloadPath, JSON.stringify(f.payload));
    const { stdout } = await exec(
      "python3",
      [
        join(root, "scripts/experiments/review-20261016-guest-result/guest-pty.py"),
        process.execPath,
        scope,
        payloadPath,
        String(acknowledge),
        directory,
      ],
      { cwd: root, timeout: 15000 },
    );
    const result = JSON.parse(stdout);
    assert(result.finalSucceeded && result.localFinishCompleted);
    assert.equal(result.exitCode, acknowledge ? 0 : 1);
    evidence.receipts.push(result);
  }
  await writeFile(join(directory, "guest-evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  for (const path of inputs) await rm(path, { force: true });
}
