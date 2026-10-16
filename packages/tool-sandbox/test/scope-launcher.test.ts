import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../../../", import.meta.url));
const owned: string[] = [];
afterEach(async () => {
  for (const path of owned.splice(0)) await rm(path, { recursive: true, force: true });
});

it.each([
  ["true", 0, false],
  ["false", 76, false],
  ["invalid", 1, true],
  ["child-reserved", 1, false],
] as const)(
  "classifies actual launcher exit with receipt mode %s",
  async (mode, code, failureText) => {
    const directory = await mkdtemp(join(tmpdir(), "pi-cloud-scope-contract-"));
    owned.push(directory);
    const operationId = randomUUID(),
      activationId = randomUUID();
    const inputPath = `/tmp/pi-cloud-envd-${operationId}.json`;
    owned.push(inputPath);
    const payload = {
      toolWorkerProtocolVersion: 7,
      type: "worker.operation",
      attachment: { activationId, toolRoot: directory },
      request: {
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.operation",
        operation: "tool.execute",
        activationId,
        operationId,
        toolCallId: "scope-call",
        toolName: "bash",
        args: { command: "printf complete" },
        timeoutMs: 20000,
        maximumOutputBytes: 51200,
      },
    };
    const payloadPath = join(directory, "payload.json");
    await writeFile(payloadPath, JSON.stringify(payload));
    let source = await readFile(join(root, "packages/tool-sandbox/src/cube-tool-scope.ts"), "utf8");
    const launch = /spawn\(\s*"\/usr\/bin\/setpriv",\s*\[[\s\S]*?inputPath,\s*\],/;
    expect((source.match(new RegExp(launch.source, "g")) ?? []).length).toBe(1);
    const args = [
      "--import",
      join(root, "node_modules/tsx/dist/loader.mjs"),
      join(root, "packages/tool-sandbox/src/envd-tool-exec.ts"),
    ];
    if (mode === "child-reserved") {
      const child = join(directory, "child.mjs");
      await writeFile(
        child,
        `process.stdout.write(JSON.stringify({toolWorkerProtocolVersion:7,type:"worker.operation_result",scopeStopRequired:false,response:{event:{isError:false}}}) + "\\n"); process.exitCode=76;`,
      );
      args.splice(0, args.length, child);
    }
    source = source
      .replace(launch, `spawn(process.execPath, [...${JSON.stringify(args)}, inputPath],`)
      .replace("file.chown(1000, 1000)", "file.chown(process.getuid!(), process.getgid!())");
    const scope = join(directory, "scope.mjs");
    await build({
      stdin: {
        contents: source,
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
              namespace: "contract",
            }));
            b.onLoad({ filter: /.*/, namespace: "contract" }, () => ({
              contents: `
        import {writeFile} from 'node:fs/promises';
        export async function enterExecutionCgroup() {}
        export async function finishExecutionCgroup() { await writeFile(process.env.REVIEW_FINISHED, 'finished'); }
        export async function stopExecutionCgroup() { return {empty:true}; }
      `,
            }));
          },
        },
      ],
    });
    const result = await exec(
      "python3",
      [
        join(root, "packages/tool-sandbox/test/fixtures/scope-pty.py"),
        process.execPath,
        scope,
        payloadPath,
        mode,
        directory,
      ],
      { cwd: root, timeout: 15000 },
    );
    expect(JSON.parse(result.stdout)).toMatchObject({
      exitCode: code,
      finalSucceeded: true,
      localFinishCompleted: true,
      scopeStopRequired: false,
      scopeFailureText: failureText,
    });
  },
  20000,
);
