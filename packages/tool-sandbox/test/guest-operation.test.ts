import { afterEach, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
const exec = promisify(execFile),
  root = fileURLToPath(new URL("../../../", import.meta.url)),
  owned: string[] = [];
afterEach(async () => {
  for (const p of owned.splice(0)) await rm(p, { recursive: true, force: true });
});
it.each(["normal", "lost_ack", "child_exit", "cancel_before_start", "cleanup_failure"])(
  "runs the fixed operation with %s without replay or premature cleanup",
  async (mode) => {
    const directory = await mkdtemp(join(tmpdir(), "pma-guest-operation-"));
    owned.push(directory);
    const id = randomUUID(),
      activationId = randomUUID(),
      token = randomUUID(),
      inputPath = `/tmp/pi-cloud-envd-${id}.json`;
    owned.push(inputPath);
    const payload = {
      toolWorkerProtocolVersion: 7,
      type: "worker.operation",
      attachment: { activationId, toolRoot: directory },
      delivery: { expiresAt: Date.now() + 15000 },
      request: {
        toolBrokerProtocolVersion: 1,
        type: "tool_sandbox.operation",
        operation: "tool.execute",
        activationId,
        operationId: id,
        toolCallId: "call",
        toolName: "bash",
        args: { command: "printf done >> effect-count; printf complete" },
        timeoutMs: 10000,
        maximumOutputBytes: 51200,
      },
    };
    await writeFile(
      join(directory, "input.json"),
      JSON.stringify({ operationId: id, token, deadline: Date.now() + 15000, payload }),
    );
    let source = await readFile(
      join(root, "packages/tool-sandbox/src/guest-tool-operation.ts"),
      "utf8",
    );
    const launch = /spawn\(\s*"\/usr\/bin\/setpriv",\s*\[[\s\S]*?inputPath,\s*\],/;
    expect((source.match(new RegExp(launch.source, "g")) ?? []).length).toBe(1);
    let args = [
      "--import",
      join(root, "node_modules/tsx/dist/loader.mjs"),
      join(root, "packages/tool-sandbox/src/envd-tool-exec.ts"),
    ];
    if (mode === "child_exit") {
      const child = join(directory, "child.mjs");
      await writeFile(child, "process.exitCode=76;");
      args = [child];
    }
    source = source
      .replace("process.getuid?.() !== 0", "false")
      .replace(launch, `spawn(process.execPath, [...${JSON.stringify(args)}, inputPath],`)
      .replace("file.chown(1000, 1000)", "file.chown(process.getuid!(),process.getgid!())");
    const executable = join(directory, "operation.mjs");
    await build({
      stdin: {
        contents: source,
        resolveDir: join(root, "packages/tool-sandbox/src"),
        loader: "ts",
      },
      bundle: true,
      platform: "node",
      format: "esm",
      outfile: executable,
      plugins: [
        {
          name: "isolated-guest",
          setup(b) {
            b.onResolve(
              {
                filter:
                  /(execution-cgroup|completion-client|guest-executor-ipc|guest-executor-store)\.ts$/,
              },
              (a) => ({ path: a.path, namespace: "fixture" }),
            );
            b.onLoad({ filter: /.*/, namespace: "fixture" }, (a) => ({
              contents: a.path.includes("execution-cgroup")
                ? `
   import {writeFile} from 'node:fs/promises';
   export async function enterExecutionCgroup(){}
   export async function finishExecutionCgroup(){if(process.env.REVIEW_MODE==='cleanup_failure')throw Error('cleanup unavailable');await writeFile(process.env.REVIEW_DIR+'/settled','yes');}
   export async function stopExecutionCgroup(){if(process.env.REVIEW_MODE==='cleanup_failure')throw Error('cleanup unavailable');return {empty:true};}
  `
                : a.path.includes("completion-client")
                  ? `
   import {writeFile} from 'node:fs/promises';
   export class GuestCompletionClient{progress(){} async complete(v){await writeFile(process.env.REVIEW_DIR+'/result.json',JSON.stringify(v));if(process.env.REVIEW_MODE==='lost_ack')throw Error('ACK lost');}}
  `
                  : a.path.includes("guest-executor-store")
                    ? `
   import {appendFileSync} from 'node:fs';
   export class GuestExecutorStore {
    claim(){appendFileSync(process.env.REVIEW_DIR+'/actions','claim\\n');return {cancelled:process.env.REVIEW_MODE==='cancel_before_start',deadline:Date.now()+10000};}
    finish(){appendFileSync(process.env.REVIEW_DIR+'/actions','finish\\n');}
    release(){appendFileSync(process.env.REVIEW_DIR+'/actions','release\\n');}
    block(){appendFileSync(process.env.REVIEW_DIR+'/actions','fault\\n');}
    close(){}
   }
  `
                    : `
   import {appendFile,writeFile} from 'node:fs/promises';
   export const GUEST_STATE='unused';export const operationInput=()=>process.env.REVIEW_DIR+'/input.json';export const operationSocket=()=>process.env.REVIEW_DIR+'/operation.sock';export const processStart=()=> 'fixture';
   export async function listenGuestRpc(p,handle){await writeFile(p,'fixture');return {close(cb){cb();}};}
  `,
            }));
          },
        },
      ],
    });
    await exec(process.execPath, [executable, id], {
      cwd: root,
      env: { ...process.env, REVIEW_DIR: directory, REVIEW_MODE: mode },
      timeout: 15000,
    });
    const result = JSON.parse(await readFile(join(directory, "result.json"), "utf8")),
      actions = (await readFile(join(directory, "actions"), "utf8")).trim().split("\n");
    expect(result.type).toBe(
      ["child_exit", "cleanup_failure"].includes(mode)
        ? "worker.failed"
        : "worker.operation_result",
    );
    if (mode === "cancel_before_start") {
      expect(result.response.event.isError).toBe(true);
      await expect(readFile(join(directory, "effect-count"))).rejects.toThrow();
    } else if (mode !== "child_exit")
      expect(await readFile(join(directory, "effect-count"), "utf8")).toBe("done");
    expect(actions).toEqual(
      mode === "cleanup_failure" ? ["claim", "fault"] : ["claim", "finish", "release"],
    );
    if (mode === "cleanup_failure")
      await expect(readFile(join(directory, "input.json"))).resolves.toBeDefined();
    else await expect(readFile(join(directory, "input.json"))).rejects.toThrow();
  },
  20000,
);
