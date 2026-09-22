import {
  createEditTool,
  createReadTool,
  createWriteTool,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  FileError,
  err,
  ok,
  truncateHead,
} from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import {
  MAX_TOOL_COMMAND_BYTES,
  type NativeToolEnd,
  type NativeToolUpdate,
  type ToolSandboxOperationRequest,
  type ToolWebProxyBootstrap,
} from "@pi-cloud/protocol";
import { spawn } from "node:child_process";
import {
  readWorkspaceFile,
  readWorkspaceFileRange,
  writeWorkspaceFile,
  resolveToolWorkspacePath,
  safeToolEnvironment,
  waitForShellProcess,
  terminateProcessGroup,
} from "./tool-worker.ts";
import { NativeToolOutput, redactToolText } from "./native-tool-output.ts";

export type NativeToolRequest = Extract<ToolSandboxOperationRequest, { operation: "tool.execute" }>;

/** Only fixed native Tool bodies run here. Never construct an Agent or a Session. */
export async function executeNativeTool(
  request: NativeToolRequest,
  cwd: string,
  signal: AbortSignal,
  onUpdate: (event: NativeToolUpdate) => void,
  webProxy?: ToolWebProxyBootstrap,
): Promise<NativeToolEnd> {
  const identity = { toolCallId: request.toolCallId, toolName: request.toolName };
  const update = (partialResult: NativeToolUpdate["partialResult"]) => {
    if (!signal.aborted)
      onUpdate({ type: "tool_execution_update", ...identity, args: request.args, partialResult });
  };
  try {
    signal.throwIfAborted();
    let result: NativeToolEnd["result"];
    if (request.toolName === "bash") {
      result = await executeNativeBash(request, cwd, signal, update, webProxy);
    } else {
      const path = request.args.path;
      if (typeof path !== "string") throw new Error("Tool path is required");
      if (path.split(/[\\/]/u).includes(".git-credentials"))
        throw new Error("Code Host credentials are not available through file tools");
      const absolutePath = resolveToolWorkspacePath(path, cwd);
      const env = new NodeExecutionEnv({ cwd });
      let digest: string | undefined;
      env.readTextFile = async (target) => {
        try {
          const file = await readWorkspaceFile(target, cwd);
          digest = file.sha256;
          return ok(file.content.toString("utf8"));
        } catch (error) {
          return err(fileError(error, target));
        }
      };
      env.readBinaryFile = async (target) => {
        try {
          return ok((await readWorkspaceFile(target, cwd)).content);
        } catch (error) {
          return err(fileError(error, target));
        }
      };
      env.writeFile = async (target, content) => {
        try {
          signal.throwIfAborted();
          await writeWorkspaceFile(
            target,
            typeof content === "string" ? content : Buffer.from(content).toString("utf8"),
            digest,
            cwd,
          );
          return ok(undefined);
        } catch (error) {
          return err(fileError(error, target));
        }
      };
      if (request.toolName === "edit") {
        result = await createEditTool().execute(
          request.toolCallId,
          { path, edits: request.args.edits as { oldText: string; newText: string }[] },
          signal,
          update,
          { env },
        );
        const details = result.details as { diff: string; patch: string };
        for (const key of ["diff", "patch"] as const) {
          const bounded = truncateHead(details[key], {
            maxBytes: Math.min(request.maximumOutputBytes, DEFAULT_MAX_BYTES),
            maxLines: DEFAULT_MAX_LINES,
          });
          if (bounded.truncated)
            details[key] =
              `${bounded.content}\n[Display truncated; file edits were applied in full.]`;
        }
      } else if (request.toolName === "write") {
        if (typeof request.args.content !== "string") throw new Error("Write content is required");
        result = await createWriteTool().execute(
          request.toolCallId,
          { path, content: request.args.content },
          signal,
          update,
          { env },
        );
      } else if (/\.(?:png|jpe?g|gif|webp|bmp)$/i.test(path)) {
        result = await createReadTool().execute(request.toolCallId, { path }, signal, update, {
          env,
        });
      } else {
        const offset = request.args.offset ?? 1,
          limit = request.args.limit ?? DEFAULT_MAX_LINES;
        if (
          !Number.isSafeInteger(offset) ||
          Number(offset) < 1 ||
          !Number.isSafeInteger(limit) ||
          Number(limit) < 1
        )
          throw new Error("tool_read_range_invalid: offset and limit must be positive integers");
        const maximum = Math.min(request.maximumOutputBytes, DEFAULT_MAX_BYTES);
        const range = await readWorkspaceFileRange(
          absolutePath,
          Number(offset),
          Math.min(Number(limit), DEFAULT_MAX_LINES),
          cwd,
          maximum,
        );
        let text =
          range.firstLineBytes === undefined
            ? range.content.toString("utf8")
            : `[Line ${range.startLine} is ${range.firstLineBytes} bytes, exceeds ${maximum} byte limit. Use bash with sed/head to inspect a bounded slice.]`;
        if (range.nextOffsetLine !== undefined)
          text += `\n\n[Showing lines ${range.startLine}-${range.endLine}. Use offset=${range.nextOffsetLine} to continue.]`;
        result = { content: [{ type: "text", text }], details: undefined };
      }
    }
    return { type: "tool_execution_end", ...identity, result, isError: false };
  } catch (error) {
    return {
      type: "tool_execution_end",
      ...identity,
      isError: true,
      result: {
        content: [
          {
            type: "text",
            text: redactToolText(error instanceof Error ? error.message : String(error)),
          },
        ],
        details: undefined,
      },
    };
  }
}

function fileError(error: unknown, path: string): FileError {
  return new FileError("unknown", error instanceof Error ? error.message : String(error), path);
}

async function executeNativeBash(
  request: NativeToolRequest,
  cwd: string,
  signal: AbortSignal,
  update: (partialResult: NativeToolUpdate["partialResult"]) => void,
  webProxy?: ToolWebProxyBootstrap,
) {
  if (typeof request.args.command !== "string") throw new Error("Bash command is required");
  if (Buffer.byteLength(request.args.command) > MAX_TOOL_COMMAND_BYTES)
    throw new Error("Bash command exceeds its byte limit");
  const output = new NativeToolOutput(request.maximumOutputBytes);
  update({ content: [], details: undefined });
  const child = spawn("/bin/bash", ["--noprofile", "--norc", "-lc", request.args.command], {
    cwd,
    detached: process.platform !== "win32",
    env: safeToolEnvironment(webProxy),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let terminationSignal: NodeJS.Signals | null = null;
  child.once("exit", (_code, signal) => {
    terminationSignal = signal;
  });
  let dirty = false;
  const append = (stream: "stdout" | "stderr", bytes: Buffer) => {
    output.append(stream, bytes);
    dirty = true;
  };
  child.stdout.on("data", (bytes: Buffer) => append("stdout", bytes));
  child.stderr.on("data", (bytes: Buffer) => append("stderr", bytes));
  const timer = setInterval(() => {
    if (dirty) {
      dirty = false;
      update(output.snapshot());
    }
  }, 100);
  let force: NodeJS.Timeout | undefined;
  const abort = () => {
    terminateProcessGroup(child, "SIGTERM");
    force ??= setTimeout(() => terminateProcessGroup(child, "SIGKILL"), 250);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    const exitCode = await waitForShellProcess(child);
    output.finish();
    update(output.snapshot());
    const status = signal.aborted
      ? signal.reason?.name === "TimeoutError"
        ? `Command timed out after ${request.timeoutMs / 1000} seconds`
        : "Command aborted"
      : exitCode === null
        ? `Command terminated${terminationSignal ? ` by ${terminationSignal}` : " without an exit code"}`
        : exitCode !== 0
          ? `Command exited with code ${exitCode}`
          : undefined;
    const result = output.result(status ? "" : "(no output)");
    if (status) throw new Error([result.content[0]!.text, status].filter(Boolean).join("\n\n"));
    return result;
  } finally {
    clearInterval(timer);
    if (force) clearTimeout(force);
    signal.removeEventListener("abort", abort);
  }
}
