import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createBashTool, createEditTool } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { executeNativeTool, type NativeToolRequest } from "../src/native-tools.ts";
import { NativeToolOutput } from "../src/native-tool-output.ts";
import type { NativeToolUpdate } from "@pi-cloud/protocol";

const directories: string[] = [];
async function directory() {
  const path = await mkdtemp(join(tmpdir(), "pi-cloud-native-tools-"));
  directories.push(path);
  return path;
}
afterEach(async () => {
  for (const path of directories.splice(0)) await rm(path, { recursive: true, force: true });
});
function request(
  toolName: NativeToolRequest["toolName"],
  args: Record<string, unknown>,
): NativeToolRequest {
  return {
    toolBrokerProtocolVersion: 1,
    type: "tool_sandbox.operation",
    operation: "tool.execute",
    activationId: randomUUID(),
    operationId: randomUUID(),
    toolCallId: "call_native",
    toolName,
    args,
    timeoutMs: 300000,
    maximumOutputBytes: 51200,
    turnContextSha256: "a".repeat(64),
    executionContextSha256: "b".repeat(64),
    stepContextSequence: 1,
    stepContextSha256: "c".repeat(64),
  };
}

describe("whole native tools at the execution source", () => {
  it.each(["printf hello", "true", "exit 7"])(
    "preserves native Pi Bash completion semantics: %s",
    async (command) => {
      const cwd = await directory();
      const native = createBashTool({
        prepare: async (execution) => {
          execution.inheritEnv = false;
        },
      });
      let expected;
      try {
        expected = {
          result: await native.execute("call_native", { command }, undefined, undefined, {
            env: new NodeExecutionEnv({ cwd, shellPath: "/bin/bash", shellEnv: {} }),
          }),
          isError: false,
        };
      } catch (error) {
        expected = {
          result: {
            content: [{ type: "text", text: (error as Error).message }],
            details: undefined,
          },
          isError: true,
        };
      }
      const actual = await executeNativeTool(
        request("bash", { command }),
        cwd,
        new AbortController().signal,
        () => {},
      );
      expect(actual).toMatchObject(expected);
    },
  );

  it("does not report success when the shell is killed without an exit code", async () => {
    const cwd = await directory();
    const actual = await executeNativeTool(
      request("bash", { command: "kill -9 $$" }),
      cwd,
      new AbortController().signal,
      () => {},
    );
    expect(actual).toMatchObject({
      isError: true,
      result: { content: [{ type: "text", text: "Command terminated by SIGKILL" }] },
    });
  });
  it("edits with the exact Pi algorithm and result, preserving CRLF/BOM", async () => {
    const cwd = await directory(),
      native = await directory();
    const content = "\ufefffirst\r\nsecond\r\n";
    await Promise.all([
      writeFile(join(cwd, "a.txt"), content),
      writeFile(join(native, "a.txt"), content),
    ]);
    const args = { path: "a.txt", edits: [{ oldText: "second", newText: "changed" }] };
    const expected = await createEditTool().execute("call_native", args, undefined, undefined, {
      env: new NodeExecutionEnv({ cwd: native }),
    });
    const actual = await executeNativeTool(
      request("edit", args),
      cwd,
      new AbortController().signal,
      () => {},
    );
    expect(actual.isError).toBe(false);
    expect(actual.result).toEqual(expected);
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe(
      await readFile(join(native, "a.txt"), "utf8"),
    );
  });
  it("keeps native edit ambiguity failures without writing", async () => {
    const cwd = await directory();
    await writeFile(join(cwd, "a.txt"), "same same");
    const result = await executeNativeTool(
      request("edit", { path: "a.txt", edits: [{ oldText: "same", newText: "new" }] }),
      cwd,
      new AbortController().signal,
      () => {},
    );
    expect(result.isError).toBe(true);
    expect(await readFile(join(cwd, "a.txt"), "utf8")).toBe("same same");
  });
  it("writes and reads without exposing full file transport", async () => {
    const cwd = await directory();
    const write = await executeNativeTool(
      request("write", { path: "sub/a.txt", content: "one\ntwo\nthree" }),
      cwd,
      new AbortController().signal,
      () => {},
    );
    expect(write.isError).toBe(false);
    const read = await executeNativeTool(
      request("read", { path: "sub/a.txt", offset: 2, limit: 1 }),
      cwd,
      new AbortController().signal,
      () => {},
    );
    expect(read.isError).toBe(false);
    expect(read.result.content[0]).toMatchObject({ text: expect.stringContaining("two") });
  });
  it("drains >1MiB without failing the command and returns native partial snapshots", async () => {
    const cwd = await directory();
    const updates: NativeToolUpdate[] = [];
    const result = await executeNativeTool(
      request("bash", { command: 'python3 -c \'print("x" * 1500000); print("finished")\'' }),
      cwd,
      new AbortController().signal,
      (event) => updates.push(event),
    );
    expect(result.isError).toBe(false);
    expect(result.result.content[0]).toMatchObject({ text: expect.stringContaining("finished") });
    expect(JSON.stringify(result).length).toBeLessThan(60000);
    expect(updates.length).toBeGreaterThan(1);
    expect(
      updates.every(
        (event) => event.type === "tool_execution_update" && event.toolCallId === "call_native",
      ),
    ).toBe(true);
    expect(JSON.stringify(result)).not.toContain("fullOutputPath");
  });
  it("preserves failing command output in a native error result", async () => {
    const cwd = await directory();
    const result = await executeNativeTool(
      request("bash", { command: "echo diagnostic; exit 7" }),
      cwd,
      new AbortController().signal,
      () => {},
    );
    expect(result.isError).toBe(true);
    expect(result.result.content[0]).toMatchObject({
      text: expect.stringMatching(/diagnostic\n+Command exited with code 7/),
    });
  });
  it("bounds cancellation and does not treat partial output as success", async () => {
    const cwd = await directory();
    const result = await executeNativeTool(
      request("bash", { command: "echo started; sleep 10" }),
      cwd,
      AbortSignal.timeout(80),
      () => {},
    );
    expect(result.isError).toBe(true);
    expect(result.result.content[0]).toMatchObject({
      text: expect.stringContaining("Command timed out"),
    });
  });
  it("handles UTF8 split across chunks and redacts source output", () => {
    const capture = new NativeToolOutput();
    const bytes = Buffer.from("你好\nglpat-123456789secret\n");
    for (const byte of bytes) capture.append("stdout", Buffer.from([byte]));
    capture.finish();
    expect(capture.result().content[0]!.text).toBe("你好\n[PI_CLOUD_REDACTED]\n");
  });
});
