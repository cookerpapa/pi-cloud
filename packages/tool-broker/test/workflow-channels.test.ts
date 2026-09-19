import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duplex } from "node:stream";
import { workflowGuestSource } from "../src/workflow-guest-source.ts";
import { WorkflowChannels, type WorkflowFrame } from "../src/workflow-channels.ts";
import type { ToolSandboxOperationRequest } from "@pi-cloud/protocol";

const children: ChildProcess[] = [],
  folders: string[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
async function start(script: string, timeoutMs = 2000) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-cloud-workflow-contract-"));
  folders.push(cwd);
  const operationId = crypto.randomUUID(),
    activationId = crypto.randomUUID();
  // Only fixed test fixtures execute locally, without inherited host credentials.
  const child = spawn(process.execPath, ["-e", workflowGuestSource({ script, cwd, operationId })], {
    cwd,
    env: {},
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);
  const stream = Duplex.from({ readable: child.stdout!, writable: child.stdin! });
  stream.on("close", () => child.kill("SIGKILL"));
  const channels = new WorkflowChannels(),
    controller = new AbortController();
  const request = {
    toolBrokerProtocolVersion: 1,
    type: "tool_sandbox.operation",
    activationId,
    operationId,
    turnContextSha256: "a".repeat(64),
    executionContextSha256: "b".repeat(64),
    stepContextSequence: 1,
    stepContextSha256: "c".repeat(64),
    toolName: "bash",
    operation: "workflow.exec",
    script,
    cwd,
    timeoutMs,
  } as const satisfies ToolSandboxOperationRequest;
  const result = channels.run(request, stream, controller.signal);
  void result.catch(() => {});
  return { channels, controller, result, request, cwd };
}
describe("workflow guest request/response contract", () => {
  it.each([
    [
      '{task:"x",sandbox:"shared",cwd:"/workspace/a"}',
      '{task:"x",sandbox:"ephemeral",cwd:"/workspace/a"}',
    ],
    [
      '{task:"x",sandbox:"ephemeral",cwd:"/workspace/a"}',
      '{task:"x",sandbox:"ephemeral",cwd:"/workspace/b"}',
    ],
  ])("rejects key reuse when compute or cwd changes: %s", async (first, second) => {
    const f = await start(`await runs.run("a",${first}); return runs.run("a",${second});`);
    const calls: WorkflowFrame[] = [];
    const bridge = await f.channels.attach(
      f.request.activationId,
      f.request.operationId,
      (frame) => {
        if (frame.type === "call") {
          calls.push(frame);
          bridge.respond({ id: frame.id, ok: true, value: { state: "completed", output: "done" } });
        }
      },
      f.controller.signal,
    );
    await expect(f.result).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("different arguments"),
    });
    expect(calls).toHaveLength(1);
  });
  it("returns only the script-selected JSON result and keeps its source in the Workspace", async () => {
    const script =
      'const a=await runs.run("a",{task:"first"}); const b=await runs.run("b",{task:"second"}); console.log(a.output); return {selected:b.output};';
    const f = await start(script),
      calls: WorkflowFrame[] = [];
    const bridge = await f.channels.attach(
      f.request.activationId,
      f.request.operationId,
      (frame) => {
        calls.push(frame);
        if (frame.type === "call")
          bridge.respond({ id: frame.id, ok: true, value: { output: frame.args.key } });
      },
      f.controller.signal,
    );
    await expect(f.result).resolves.toMatchObject({
      operation: "workflow.exec",
      ok: true,
      value: { selected: "b" },
    });
    expect(calls.filter((f) => f.type === "call")).toHaveLength(2);
    expect(calls.some((f) => f.type === "progress")).toBe(true);
    await expect(
      readFile(join(f.cwd, "workflows", f.request.operationId + ".js"), "utf8"),
    ).resolves.toBe(script);
  });
  it("keeps fanout results in input order, not completion order", async () => {
    const f = await start(
      'return (await runs.all([{key:"a",task:"first"},{key:"b",task:"second"}])).map(r=>r.output);',
    );
    const bridge = await f.channels.attach(
      f.request.activationId,
      f.request.operationId,
      (frame) => {
        if (frame.type === "call")
          setTimeout(
            () => bridge.respond({ id: frame.id, ok: true, value: { output: frame.args.key } }),
            frame.args.key === "a" ? 30 : 1,
          );
      },
      f.controller.signal,
    );
    await expect(f.result).resolves.toMatchObject({ ok: true, value: ["a", "b"] });
  });
  it("does not launch twice for the same workflow key", async () => {
    const f = await start(
      'const a=runs.run("a",{task:"x"});const b=runs.run("a",{task:"x"});return await Promise.all([a,b]);',
    );
    let count = 0;
    const bridge = await f.channels.attach(
      f.request.activationId,
      f.request.operationId,
      (frame) => {
        if (frame.type === "call") {
          count++;
          bridge.respond({ id: frame.id, ok: true, value: { output: "one" } });
        }
      },
      f.controller.signal,
    );
    await expect(f.result).resolves.toMatchObject({
      ok: true,
      value: [{ output: "one" }, { output: "one" }],
    });
    expect(count).toBe(1);
  });
  it("fails on an unawaited child instead of claiming workflow success", async () => {
    const f = await start('runs.run("a",{task:"x"});return "done";');
    await expect(f.result).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining("unawaited"),
    });
  });
  it("refuses another binding and releases a cancelled script", async () => {
    const f = await start('await runs.run("a",{task:"wait"});');
    await expect(
      f.channels.attach(crypto.randomUUID(), f.request.operationId, () => {}, f.controller.signal),
    ).rejects.toThrow("another Tool binding");
    f.controller.abort();
    await expect(f.result).rejects.toThrow();
  });
  it("bounds a script which never yields", async () => {
    const f = await start("while(true){}", 100);
    await expect(f.result).rejects.toThrow();
  });
});
