import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm, writeFile, mkdir, symlink, lstat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { createBashTool, createEditTool, createReadTool } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
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
  };
}

describe("whole native tools at the execution source", () => {
  it.each([
    { name: "leading @", file: "sample.txt", path: "@sample.txt" },
    { name: "doubled @", file: "@literal.txt", path: "@@literal.txt" },
    { name: "Unicode space", file: "my file.txt", path: "my\u00a0file.txt" },
    { name: "timestamp space", file: "screen 1.00\u202fPM.txt", path: "screen 1.00 PM.txt" },
    { name: "decomposed filename", file: "cafe\u0301.txt", path: "caf\u00e9.txt" },
    { name: "curly apostrophe", file: "it\u2019s.txt", path: "it's.txt" },
    { name: "combined variants", file: "cafe\u0301\u2019s.txt", path: "caf\u00e9's.txt" },
    { name: "literal @ collision", file: "target.txt", path: "@target.txt", collision: true },
  ])("uses Pi's Read target selection ($name)", async (sample) => {
    const root = await directory();
    await writeFile(join(root, sample.file), "expected file\n");
    if (sample.collision) await writeFile(join(root, sample.path), "different file\n");
    const args = { path: sample.path };
    const native = await createReadTool().execute(
      args,
      {
        env: new NodeExecutionEnv({ cwd: root }),
        diagnostic: () => {},
      } as unknown as ToolExecutionApi,
      BACKGROUND_CONTEXT,
    );
    const cloud = await executeNativeTool(
      request("read", args),
      root,
      new AbortController().signal,
      () => {},
    );
    expect(cloud.isError).toBe(false);
    expect(cloud.result.content).toEqual(native.content);
    expect(cloud.result.content).toEqual([{ type: "text", text: "expected file\n" }]);
  });

  it("uses the same interpreted path for Write, Edit and Read", async () => {
    const root = await directory(),
      signal = new AbortController().signal;
    const path = "@my\u00a0file.txt";
    expect(
      (
        await executeNativeTool(
          request("write", { path, content: "before" }),
          root,
          signal,
          () => {},
        )
      ).isError,
    ).toBe(false);
    expect(
      (
        await executeNativeTool(
          request("edit", { path, edits: [{ oldText: "before", newText: "after" }] }),
          root,
          signal,
          () => {},
        )
      ).isError,
    ).toBe(false);
    const read = await executeNativeTool(request("read", { path }), root, signal, () => {});
    expect(read.isError).toBe(false);
    expect(read.result.content).toEqual([{ type: "text", text: "after" }]);
    expect(await readFile(join(root, "my file.txt"), "utf8")).toBe("after");
  });

  it("resolves image paths before the cloud image extension", async () => {
    const root = await directory();
    await sharp({ create: { width: 2, height: 3, channels: 3, background: "red" } })
      .png()
      .toFile(join(root, "picture.png"));
    const result = await executeNativeTool(
      request("read", { path: "@picture.png" }),
      root,
      new AbortController().signal,
      () => {},
    );
    expect(result.isError).toBe(false);
    expect(result.result.content.some((part) => part.type === "image")).toBe(true);
  });

  it.each(["read", "write", "edit"] as const)(
    "applies the existing credential-path guard after interpretation (%s)",
    async (tool) => {
      const root = await directory();
      await writeFile(join(root, ".git-credentials"), "fixture bytes");
      const result = await executeNativeTool(
        request(tool, {
          path: "@.git-credentials",
          content: "replacement",
          edits: [{ oldText: "fixture", newText: "replacement" }],
        }),
        root,
        new AbortController().signal,
        () => {},
      );
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.result)).toContain("not available through file tools");
      expect(await readFile(join(root, ".git-credentials"), "utf8")).toBe("fixture bytes");
    },
  );

  it.each([false, true])(
    "cancels only the Bash process group (separate session=%s)",
    async (separate) => {
      const root = await directory(),
        cancel = new AbortController();
      const childFile = join(root, "service.pid");
      const cmd = `${separate ? "setsid" : "nohup"} sleep 60 >service.log 2>&1 </dev/null & echo $! > service.pid; echo partial-before-cancel; wait`;
      const running = executeNativeTool(
        request("bash", { command: cmd }),
        root,
        cancel.signal,
        () => {},
      );
      let pid: number | undefined;
      const alive = async () => {
        try {
          const s = await readFile(`/proc/${pid}/stat`, "utf8");
          return !["Z", "X"].includes(s.slice(s.lastIndexOf(")") + 2).split(" ")[0]!);
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
          throw e;
        }
      };
      try {
        await vi.waitFor(async () => {
          pid = Number(await readFile(childFile, "utf8"));
          expect(await alive()).toBe(true);
        });
        // Observe the session change before interrupting to avoid testing the
        // unrelated race between fork and setsid itself.
        if (separate)
          await vi.waitFor(async () => {
            const s = await readFile(`/proc/${pid}/stat`, "utf8");
            const fields = s.slice(s.lastIndexOf(")") + 2).split(" ");
            expect(Number(fields[2])).toBe(pid);
          });
        cancel.abort();
        const result = await running;
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result.result)).toContain("partial-before-cancel");
        expect(JSON.stringify(result.result)).toContain("Command aborted");
        await vi.waitFor(async () => expect(await alive()).toBe(separate));
      } finally {
        cancel.abort();
        await running;
        if (pid && (await alive())) process.kill(pid, "SIGKILL");
      }
    },
  );

  it("leaves a completed background launch alive when a later Bash is cancelled", async () => {
    const root = await directory();
    const launched = await executeNativeTool(
      request("bash", {
        command: "nohup sleep 60 >service.log 2>&1 </dev/null & echo $! > service.pid",
      }),
      root,
      new AbortController().signal,
      () => {},
    );
    expect(launched.isError).toBe(false);
    const pid = Number(await readFile(join(root, "service.pid"), "utf8"));
    const cancel = new AbortController();
    const running = executeNativeTool(
      request("bash", { command: "echo ready > next.ready; sleep 60" }),
      root,
      cancel.signal,
      () => {},
    );
    try {
      await vi.waitFor(async () =>
        expect(await readFile(join(root, "next.ready"), "utf8")).toBe("ready\n"),
      );
      cancel.abort();
      expect((await running).isError).toBe(true);
      expect(() => process.kill(pid, 0)).not.toThrow();
    } finally {
      cancel.abort();
      await running;
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
  });
  it.each([
    { text: "first\nsecond\n", offset: 1 },
    { text: "first\nsecond\n", offset: 3 },
    { text: "first\r\nsecond\r\n", offset: 1 },
    { text: "first\rsecond\n", offset: 1 },
    { text: "\uFEFFfirst\n", offset: 1 },
    { text: "", offset: 1 },
  ])("matches Pi text-read line and BOM semantics for %j", async ({ text, offset }) => {
    const root = await directory();
    await writeFile(join(root, "lines.txt"), text);
    const args = { path: "lines.txt", offset };
    const signal = new AbortController().signal;
    const native = await createReadTool().execute(
      args,
      {
        env: new NodeExecutionEnv({ cwd: root }),
        diagnostic: () => {},
      } as unknown as ToolExecutionApi,
      withAbortSignal(signal, BACKGROUND_CONTEXT),
    );
    const remote = await executeNativeTool(request("read", args), root, signal, () => {});
    expect(remote.isError).toBe(false);
    expect(remote.result.content).toEqual(native.content);
  });

  it.each([
    ["ASCII", "PREFIX_" + "x".repeat(120000)],
    ["UTF-8 three-byte", "界".repeat(30000)],
    ["UTF-8 four-byte", "a😀".repeat(30000)],
    ["BOM and CRLF", "\uFEFF" + "界".repeat(30000) + "\r"],
  ])("keeps native long-line content and diagnostics (%s)", async (_name, text) => {
    const root = await directory();
    for (const offset of [1, 2]) {
      await writeFile(join(root, "bundle.txt"), (offset === 2 ? "header\n" : "") + text + "\nlast");
      for (const limit of [undefined, 1]) {
        const args = { path: "bundle.txt", offset, ...(limit === undefined ? {} : { limit }) };
        const native = await createReadTool().execute(
          args,
          {
            env: new NodeExecutionEnv({ cwd: root }),
            diagnostic: () => {},
          } as unknown as ToolExecutionApi,
          BACKGROUND_CONTEXT,
        );
        const cloud = await executeNativeTool(
          request("read", args),
          root,
          new AbortController().signal,
          () => {},
        );
        expect(cloud.isError).toBe(false);
        expect(cloud.result.content).toEqual(native.content);
        expect(cloud.result.diagnostics).toEqual(native.diagnostics);
        const content = cloud.result.content[0];
        expect(content?.type).toBe("text");
        if (content?.type === "text") {
          expect(content.text).not.toContain("\uFFFD");
          expect(Buffer.byteLength(content.text)).toBeLessThanOrEqual(51200);
        }
      }
    }
  });

  it.each([1, 2000, 3000])(
    "separates continuation guidance from file data (limit=%s)",
    async (limit) => {
      const root = await directory();
      const text = Array.from({ length: 3001 }, (_, n) => String(n)).join("\n");
      await writeFile(join(root, "lines.txt"), text);
      const args = { path: "lines.txt", offset: 2, limit };
      const native = await createReadTool().execute(
        args,
        {
          env: new NodeExecutionEnv({ cwd: root }),
          diagnostic: () => {},
        } as unknown as ToolExecutionApi,
        BACKGROUND_CONTEXT,
      );
      const cloud = await executeNativeTool(
        request("read", args),
        root,
        new AbortController().signal,
        () => {},
      );
      expect(cloud.isError).toBe(false);
      expect(cloud.result.content).toEqual(native.content);
      const next = 2 + Math.min(2000, limit);
      if (next <= 3001) expect(cloud.result.diagnostics?.[0]?.message).toContain(`offset=${next}`);
    },
  );

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
  it("reads EXIF-rotated images using display dimensions", async () => {
    const root = await directory(),
      path = join(root, "camera.jpg");
    await writeFile(
      path,
      await sharp({ create: { width: 80, height: 40, channels: 3, background: "blue" } })
        .jpeg()
        .withMetadata({ orientation: 6 })
        .toBuffer(),
    );
    const result = await executeNativeTool(
      request("read", { path }),
      root,
      new AbortController().signal,
      () => {},
    );
    const image = result.result.content.find((part) => part.type === "image");
    if (!image || image.type !== "image") throw new Error("No read image");
    const metadata = await sharp(Buffer.from(image.data, "base64")).metadata();
    expect([metadata.width, metadata.height, metadata.orientation]).toEqual([40, 80, undefined]);
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
      result: { content: [] },
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
      let expected,
        output = "";
      try {
        await native.execute(
          { command },
          {
            env: new NodeExecutionEnv({ cwd, shellPath: "/bin/bash", shellEnv: {} }),
            output: (text: string) => {
              output += text;
            },
            diagnostic: () => {},
          } as unknown as ToolExecutionApi,
          BACKGROUND_CONTEXT,
        );
        expected = {
          isError: false,
          result: { content: [{ type: "text", text: output || "(no output)" }] },
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
    const expected = await createEditTool().execute(
      args,
      {
        env: new NodeExecutionEnv({ cwd: native }),
        diagnostic: () => {},
      } as unknown as ToolExecutionApi,
      BACKGROUND_CONTEXT,
    );
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
  it("drains >1MiB into a bounded final result", async () => {
    const cwd = await directory();
    const result = await executeNativeTool(
      request("bash", { command: 'python3 -c \'print("x" * 1500000); print("finished")\'' }),
      cwd,
      new AbortController().signal,
      () => {},
    );
    expect(result.isError).toBe(false);
    expect(result.result.content[0]).toMatchObject({ text: expect.stringContaining("finished") });
    expect(JSON.stringify(result).length).toBeLessThan(60000);
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
