import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createBashTool, createEditTool } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { executeNativeTool, type NativeToolRequest } from "../src/native-tools.ts";
import { NativeToolOutput } from "../src/native-tool-output.ts";
import type { NativeToolUpdate } from "@pi-cloud/protocol";
import sharp from "sharp";

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
  it("reads image magic without depending on a filename extension", async () => {
    const root = await directory();
    const path = join(root, "screenshot");
    await writeFile(
      path,
      await sharp({ create: { width: 320, height: 200, channels: 3, background: "blue" } })
        .png()
        .toBuffer(),
    );
    const result = await executeNativeTool(
      request("read", { path, detail: "original" }),
      root,
      new AbortController().signal,
      () => {},
    );
    expect(result).toMatchObject({ isError: false });
    expect(result.result.content).toContainEqual(
      expect.objectContaining({ type: "image", mimeType: "image/png" }),
    );
  });
  it("treats cwd as a base and follows guest file links without replacing them", async () => {
    const root = await directory();
    const cwd = join(root, "repo");
    await mkdir(cwd);
    await writeFile(join(root, "shared.txt"), "before");
    await symlink("../shared.txt", join(cwd, "linked.txt"));
    const execute = (name: NativeToolRequest["toolName"], args: Record<string, unknown>) =>
      executeNativeTool(request(name, args), cwd, new AbortController().signal, () => {});
    expect(await execute("read", { path: "../shared.txt" })).toMatchObject({
      isError: false,
      result: { content: [{ text: "before" }] },
    });
    expect(await execute("read", { path: join(root, "shared.txt") })).toMatchObject({
      isError: false,
    });
    expect(
      await execute("edit", {
        path: "linked.txt",
        edits: [{ oldText: "before", newText: "edited" }],
      }),
    ).toMatchObject({ isError: false });
    expect(await readFile(join(root, "shared.txt"), "utf8")).toBe("edited");
    expect((await lstat(join(cwd, "linked.txt"))).isSymbolicLink()).toBe(true);
    expect(await execute("write", { path: "linked.txt", content: "written" })).toMatchObject({
      isError: false,
    });
    expect(await readFile(join(root, "shared.txt"), "utf8")).toBe("written");
    await symlink("../new.txt", join(cwd, "new-link.txt"));
    expect(await execute("write", { path: "new-link.txt", content: "created" })).toMatchObject({
      isError: false,
    });
    expect(await readFile(join(root, "new.txt"), "utf8")).toBe("created");
    expect(await execute("read", { path: "/proc/self/status", limit: 1 })).toMatchObject({
      isError: false,
      result: { content: [{ text: expect.stringContaining("Name:") }] },
    });
    await writeFile(join(cwd, "empty.txt"), "");
    expect(await execute("read", { path: "empty.txt" })).toMatchObject({
      isError: false,
      result: { content: [{ text: "" }] },
    });
  });

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
  it("drains >1MiB and returns only a final result for a short command", async () => {
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
    expect(updates).toHaveLength(0);
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
  it("observes a long noisy command at most once per second and never after completion", async () => {
    const cwd = await directory();
    const updates: NativeToolUpdate[] = [];
    const result = await executeNativeTool(
      request("bash", {
        command:
          'python3 -u -c \'import time; [(print("x"*100000), time.sleep(.1)) for _ in range(23)]; print("DONE")\'',
      }),
      cwd,
      new AbortController().signal,
      (event) => updates.push(event),
    );
    expect(result.isError).toBe(false);
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates.length).toBeLessThanOrEqual(3);
    expect(
      updates.every((event) => Buffer.byteLength(JSON.stringify(event.partialResult)) < 110000),
    ).toBe(true);
    expect(JSON.stringify(result.result)).toContain("DONE");
    const count = updates.length;
    await new Promise((resolve) => setTimeout(resolve, 1100));
    expect(updates).toHaveLength(count);
  });
  it("finishes a silent long command without requiring observation heartbeats", async () => {
    const updates: NativeToolUpdate[] = [];
    const result = await executeNativeTool(
      request("bash", { command: "sleep 1.2" }),
      await directory(),
      new AbortController().signal,
      (event) => updates.push(event),
    );
    expect(result.isError).toBe(false);
    expect(updates).toEqual([]);
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
