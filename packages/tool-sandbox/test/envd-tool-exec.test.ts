import { afterEach, expect, it, vi } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseToolWorkerOutput } from "@pi-cloud/protocol";

const exec = promisify(execFile);
const owned: string[] = [];
afterEach(async () => {
  for (const path of owned.splice(0)) await rm(path, { recursive: true, force: true });
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-cloud-cwd-test-"));
  owned.push(root);
  const cwd = join(root, "project"),
    marker = join(root, "executed");
  await mkdir(cwd);
  return { root, cwd, marker };
}
async function run(
  cwd: string,
  command: string,
  transform: (input: Record<string, unknown>) => unknown = (input) => input,
) {
  const activationId = randomUUID(),
    operationId = randomUUID();
  const path = `/tmp/pi-cloud-envd-${operationId}.json`;
  owned.push(path);
  await writeFile(
    path,
    JSON.stringify(
      transform({
        toolWorkerProtocolVersion: 6,
        type: "worker.operation",
        attachment: {
          activationId,
          toolRoot: cwd,
        },
        request: {
          toolBrokerProtocolVersion: 1,
          type: "tool_sandbox.operation",
          operation: "tool.execute",
          activationId,
          operationId,
          toolCallId: "cwd-call",
          toolName: "bash",
          args: { command },
          timeoutMs: 10000,
          maximumOutputBytes: 51200,
        },
      }),
    ),
    { mode: 0o600 },
  );
  const result = await exec(
    process.execPath,
    ["--import", "tsx", fileURLToPath(new URL("../src/envd-tool-exec.ts", import.meta.url)), path],
    { timeout: 20000, maxBuffer: 1024 * 1024 },
  );
  return parseToolWorkerOutput(JSON.parse(result.stdout.trim().split("\n").at(-1)!));
}

it.each(["attachment identity", "old version", "unused initializer", "old wrapper"])(
  "rejects invalid execution attachment before command effects: %s",
  async (kind) => {
    const f = await fixture();
    const result = await run(f.cwd, `printf executed > '${f.marker}'`, (input) => {
      if (kind === "attachment identity")
        return {
          ...input,
          attachment: { ...(input.attachment as object), activationId: randomUUID() },
        };
      if (kind === "old version") return { ...input, toolWorkerProtocolVersion: 5 };
      if (kind === "unused initializer")
        return {
          ...input,
          attachment: { ...(input.attachment as object), workspaceSeed: { kind: "sample_java" } },
        };
      return { mode: "operation", initialization: input.attachment, operation: input.request };
    });
    expect(result).toMatchObject({ type: "worker.failed" });
    if (kind === "attachment identity")
      expect(result).toMatchObject({ code: "tool_worker_identity_mismatch" });
    await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
  },
);

it("returns a native Tool error after cwd deletion without starting the command", async () => {
  const f = await fixture();
  await rm(f.cwd, { recursive: true });
  const result = await run(f.cwd, `printf executed > '${f.marker}'`);
  expect(result).toMatchObject({
    type: "worker.operation_result",
    scopeStopRequired: false,
    response: {
      type: "tool_sandbox.operation_result",
      event: {
        toolCallId: "cwd-call",
        toolName: "bash",
        isError: true,
        result: {
          content: [{ type: "text", text: expect.stringContaining("tool_root_unavailable") }],
        },
      },
    },
  });
  await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFile(f.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  await mkdir(f.cwd);
  expect(await run(f.cwd, `printf restored > '${f.marker}'`)).toMatchObject({
    type: "worker.operation_result",
    response: { event: { isError: false } },
  });
  expect(await readFile(f.marker, "utf8")).toBe("restored");
});

it("returns a native Tool error when the selected directory becomes a file", async () => {
  const f = await fixture();
  await rm(f.cwd, { recursive: true });
  await writeFile(f.cwd, "keep this file");
  expect(await run(f.cwd, `printf executed > '${f.marker}'`)).toMatchObject({
    type: "worker.operation_result",
    response: { event: { isError: true } },
  });
  await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
  expect(await readFile(f.cwd, "utf8")).toBe("keep this file");
  expect(await run(join(f.cwd, "nested"), `printf executed > '${f.marker}'`)).toMatchObject({
    type: "worker.operation_result",
    response: { event: { isError: true } },
  });
  await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
});

it("does not reinterpret unexpected directory resolution failure as a native Tool result", async () => {
  const f = await fixture(),
    loop = join(f.root, "loop");
  await symlink(loop, loop);
  expect(await run(loop, `printf executed > '${f.marker}'`)).toMatchObject({
    type: "worker.operation_result",
    response: { type: "tool_sandbox.operation_failed" },
  });
  await expect(readFile(f.marker)).rejects.toMatchObject({ code: "ENOENT" });
});

it("finishes a started command after cwd deletion and rejects only the next Tool", async () => {
  const f = await fixture();
  const running = run(f.cwd, `printf started > '${f.marker}'; sleep 2; printf finished`);
  // Observe the process before deleting only this test's directory.
  await vi.waitFor(async () => expect(await readFile(f.marker, "utf8")).toBe("started"), {
    timeout: 10000,
  });
  await rm(f.cwd, { recursive: true });
  expect(await running).toMatchObject({
    type: "worker.operation_result",
    response: {
      event: {
        isError: false,
        result: { content: [{ type: "text", text: "finished" }] },
      },
    },
  });
  expect(await run(f.cwd, `printf replayed > '${f.marker}'`)).toMatchObject({
    type: "worker.operation_result",
    response: { event: { isError: true } },
  });
  expect(await readFile(f.marker, "utf8")).toBe("started");
});
