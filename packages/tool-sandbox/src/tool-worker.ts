import {
  canonicalEnvironmentRecipeJson,
  isExpectedDefaultToolchain,
  MAX_TOOL_MUTATION_FILE_BYTES,
  MAX_TOOL_OUTPUT_BYTES,
  MAX_TOOL_RANGE_FILE_BYTES,
  MAX_TOOL_READ_RANGE_BYTES,
  type EnvironmentRuntimeSnapshot,
  type EnvironmentRecipeCommand,
  type EnvironmentRecipeCommandResult,
  type EnvironmentToolName,
  type EnvironmentToolchainReport,
  type ToolWorkerInput,
  type ToolSandboxOperationRequest,
  type ToolSandboxOperationResponse,
  type ToolWebProxyBootstrap,
} from "@pi-cloud/protocol";
import {
  createWorkspaceSeed,
  decodeWorkspaceBlob,
  initializeWorkspaceSeed,
} from "@pi-cloud/workspace-runtime";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isIPv4 } from "node:net";

let TOOL_WORKSPACE_DIRECTORY = "/workspace";
const SAMPLE_JAVA_FIXTURE = "/opt/pi-cloud/sample-java-repair";
const TOOL_IMAGE_REVISION_FILE = "/opt/pi-cloud/image-revision";
const SHELL_EXIT_STDIO_GRACE_MS = 100;
const TOOLCHAIN_PROBE_TIMEOUT_MS = 30_000;

export class ToolWorkerError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, safeMessage: string, retryable = false) {
    super(safeMessage);
    this.name = "ToolWorkerError";
    this.code = code;
    this.retryable = retryable;
  }
}

function probeVersion(
  name: EnvironmentToolName,
  file: string,
  args: readonly string[],
): Promise<string> {
  return new Promise<string>((resolvePromise, rejectPromise) => {
    execFile(
      file,
      [...args],
      {
        cwd: TOOL_WORKSPACE_DIRECTORY,
        encoding: "utf8",
        maxBuffer: 8 * 1_024,
        timeout: TOOLCHAIN_PROBE_TIMEOUT_MS,
        env: safeToolEnvironment(),
      },
      (error, stdout, stderr) => {
        if (error) {
          const timedOut = error.killed === true && error.signal !== null;
          rejectPromise(
            new ToolWorkerError(
              "environment_preflight_failed",
              timedOut
                ? `Tool Sandbox ${name} preflight timed out`
                : `Tool Sandbox ${name} preflight failed`,
              timedOut,
            ),
          );
          return;
        }
        const output = `${stdout}${stderr}`.trim().split("\n", 1)[0]?.trim() ?? "";
        if (output.length < 1 || output.length > 256 || /[\u0000-\u001f\u007f]/.test(output)) {
          rejectPromise(
            new ToolWorkerError(
              "environment_preflight_failed",
              `Tool Sandbox ${name} preflight returned invalid evidence`,
              false,
            ),
          );
          return;
        }
        resolvePromise(output);
      },
    );
  });
}

async function readBakedImageRevision(): Promise<string> {
  let handle;
  try {
    handle = await open(TOOL_IMAGE_REVISION_FILE, constants.O_RDONLY | constants.O_NOFOLLOW);
    const bytes = Buffer.alloc(130);
    const result = await handle.read(bytes, 0, bytes.byteLength, 0);
    if (result.bytesRead === bytes.byteLength) {
      throw new ToolWorkerError(
        "environment_image_evidence_invalid",
        "Tool Sandbox image revision evidence was invalid",
        false,
      );
    }
    return bytes.subarray(0, result.bytesRead).toString("utf8").trim();
  } catch (error) {
    if (error instanceof ToolWorkerError) throw error;
    throw new ToolWorkerError(
      "environment_image_evidence_invalid",
      "Tool Sandbox image revision evidence was invalid",
      false,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function validateToolEnvironment(
  environment: EnvironmentRuntimeSnapshot,
  physicalImageRevision?: string,
): Promise<EnvironmentToolchainReport> {
  const imageRevision = physicalImageRevision ?? (await readBakedImageRevision());
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(imageRevision)) {
    throw new ToolWorkerError(
      "environment_image_evidence_invalid",
      "Tool Sandbox image revision evidence was invalid",
      false,
    );
  }
  if (imageRevision !== environment.imageRevision) {
    throw new ToolWorkerError(
      "environment_image_mismatch",
      "Tool Sandbox image revision did not match the accepted Run",
      false,
    );
  }
  const recipeSha256 = createHash("sha256")
    .update(canonicalEnvironmentRecipeJson(environment.recipe))
    .digest("hex");
  if (recipeSha256 !== environment.recipeSha256) {
    throw new ToolWorkerError(
      "environment_recipe_mismatch",
      "Tool Sandbox environment recipe did not match the accepted Run",
      false,
    );
  }
  const probes: readonly [EnvironmentToolName, string, readonly string[]][] = [
    ["node", "/usr/local/bin/node", ["--version"]],
    ["java", "/usr/bin/java", ["-version"]],
    ["python", "/usr/bin/python3", ["--version"]],
    ["git", "/usr/bin/git", ["--version"]],
  ];
  const tools = await Promise.all(
    probes.map(async ([name, file, args]) => ({
      name,
      version: await probeVersion(name, file, args),
    })),
  );
  const report: EnvironmentToolchainReport = {
    profileKey: environment.profileKey,
    profileVersion: environment.profileVersion,
    imageRevision: environment.imageRevision,
    specSha256: environment.specSha256,
    recipeSha256,
    tools,
    recipeCommands: [],
  };
  if (!isExpectedDefaultToolchain(report)) {
    throw new ToolWorkerError(
      "environment_toolchain_mismatch",
      "Tool Sandbox toolchain did not match its environment profile",
      false,
    );
  }
  return report;
}

type EnvironmentCommandExecution = {
  exitCode: number | null;
  output: Buffer;
  timedOut: boolean;
};

async function executeEnvironmentCommand(
  command: EnvironmentRecipeCommand,
  workspaceDirectory: string,
  webProxy?: ToolWebProxyBootstrap,
): Promise<EnvironmentCommandExecution> {
  if (command.network === "dependency" && webProxy === undefined) {
    throw new ToolWorkerError(
      "environment_dependency_network_unavailable",
      `Environment command ${command.id} requires an unavailable dependency network policy`,
      false,
    );
  }
  const workspaceRoot = await realpath(workspaceDirectory).catch(() => {
    throw new ToolWorkerError(
      "environment_workspace_unavailable",
      "Environment workspace was unavailable",
      false,
    );
  });
  const cwd = resolve(workspaceRoot, command.cwd);
  const fromRoot = relative(workspaceRoot, cwd);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new ToolWorkerError(
      "environment_command_path_escape",
      `Environment command ${command.id} escaped the workspace`,
      false,
    );
  }
  const canonicalCwd = await realpath(cwd).catch(() => {
    throw new ToolWorkerError(
      "environment_command_working_directory_missing",
      `Environment command ${command.id} working directory was unavailable`,
      false,
    );
  });
  const canonicalFromRoot = relative(workspaceRoot, canonicalCwd);
  if (
    canonicalFromRoot === ".." ||
    canonicalFromRoot.startsWith(`..${sep}`) ||
    isAbsolute(canonicalFromRoot)
  ) {
    throw new ToolWorkerError(
      "environment_command_path_escape",
      `Environment command ${command.id} escaped the workspace`,
      false,
    );
  }
  const child = spawn("/bin/bash", ["--noprofile", "--norc", "-lc", command.command], {
    cwd: canonicalCwd,
    detached: process.platform !== "win32",
    env: command.network === "dependency" ? safeToolEnvironment(webProxy) : safeToolEnvironment(),
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = Buffer.alloc(0);
  let overflow = false;
  let timedOut = false;
  const append = (chunk: Buffer): void => {
    if (overflow) return;
    output = Buffer.concat([output, chunk]);
    if (output.byteLength > MAX_TOOL_OUTPUT_BYTES) {
      overflow = true;
      terminateProcessGroup(child, "SIGKILL");
    }
  };
  child.stdout?.on("data", append);
  child.stderr?.on("data", append);
  const timer = setTimeout(() => {
    timedOut = true;
    terminateProcessGroup(child, "SIGTERM");
    const force = setTimeout(() => terminateProcessGroup(child, "SIGKILL"), 250);
    force.unref();
  }, command.timeoutMs);
  timer.unref();
  try {
    const result = await new Promise<{ exitCode: number | null }>(
      (resolvePromise, rejectPromise) => {
        child.once("error", () =>
          rejectPromise(
            new ToolWorkerError(
              "environment_command_start_failed",
              `Environment command ${command.id} could not start`,
              false,
            ),
          ),
        );
        child.once("close", (exitCode) => resolvePromise({ exitCode }));
      },
    );
    if (overflow) {
      throw new ToolWorkerError(
        "environment_command_output_limit",
        `Environment command ${command.id} exceeded its output limit`,
        false,
      );
    }
    return { exitCode: result.exitCode, output, timedOut };
  } finally {
    clearTimeout(timer);
    // A setup command is allowed to download dependencies, but that authority
    // must not survive the command boundary in a detached child. Bash can
    // otherwise exit after redirecting a background process, leaving that
    // process with the proxy capability in its inherited environment.
    terminateProcessGroup(child, "SIGKILL");
  }
}

export async function executeEnvironmentRecipe(
  environment: EnvironmentRuntimeSnapshot,
  workspaceDirectory = TOOL_WORKSPACE_DIRECTORY,
  options: {
    webProxy?: ToolWebProxyBootstrap;
  } = {},
): Promise<EnvironmentRecipeCommandResult[]> {
  const recipeSha256 = createHash("sha256")
    .update(canonicalEnvironmentRecipeJson(environment.recipe))
    .digest("hex");
  if (recipeSha256 !== environment.recipeSha256) {
    throw new ToolWorkerError(
      "environment_recipe_mismatch",
      "Tool Sandbox environment recipe did not match the accepted Run",
      false,
    );
  }
  const dependencyHosts = environment.recipe.dependencyHosts ?? [];
  const webProxy = options.webProxy;
  if (dependencyHosts.length > 0 !== (webProxy !== undefined)) {
    throw new ToolWorkerError(
      "environment_dependency_network_unavailable",
      "Environment dependency network capability did not match the accepted recipe",
      false,
    );
  }
  const phases: readonly (readonly [
    "setup" | "verification",
    readonly EnvironmentRecipeCommand[],
  ])[] = [
    ["setup", environment.recipe.setupCommands],
    ["verification", environment.recipe.verificationCommands],
  ];
  const results: EnvironmentRecipeCommandResult[] = [];
  for (const [phase, commands] of phases) {
    for (const command of commands) {
      const startedAt = Date.now();
      const result = await executeEnvironmentCommand(command, workspaceDirectory, webProxy);
      if (result.timedOut) {
        throw new ToolWorkerError(
          "environment_command_timeout",
          `Environment command ${command.id} timed out`,
          false,
        );
      }
      if (result.exitCode !== 0) {
        throw new ToolWorkerError(
          phase === "setup"
            ? "environment_setup_command_failed"
            : "environment_verification_command_failed",
          `Environment command ${command.id} failed`,
          false,
        );
      }
      results.push({
        id: command.id,
        phase,
        exitCode: result.exitCode,
        durationMs: Math.max(0, Date.now() - startedAt),
        outputSha256: createHash("sha256").update(result.output).digest("hex"),
      });
    }
  }
  return results;
}

export function dependencyRecipeWebProxy(
  environment: EnvironmentRuntimeSnapshot,
  webProxy: ToolWebProxyBootstrap | undefined,
): ToolWebProxyBootstrap | undefined {
  return (environment.recipe.dependencyHosts?.length ?? 0) > 0 ? webProxy : undefined;
}

export function safeToolEnvironment(webProxy?: ToolWebProxyBootstrap): NodeJS.ProcessEnv {
  const gitCredentialRoot = TOOL_WORKSPACE_DIRECTORY.startsWith("/home/user")
    ? "/home/user"
    : "/workspace";
  const gitCredentials = `${gitCredentialRoot}/.git-credentials`;
  const loopbackNoProxy = "127.0.0.1,localhost,::1";
  let proxyEnvironment: NodeJS.ProcessEnv = {};
  if (webProxy !== undefined) {
    const directPrivateCidrs = webProxy.directPrivateCidrs ?? [];
    if (
      !isIPv4(webProxy.host) ||
      !Number.isSafeInteger(webProxy.port) ||
      webProxy.port < 1 ||
      webProxy.port > 65_535 ||
      directPrivateCidrs.length > 8 ||
      directPrivateCidrs.some((cidr) => !/^(?:\d{1,3}\.){3}\d{1,3}\/(?:2[4-9]|3[0-2])$/u.test(cidr))
    ) {
      throw new ToolWorkerError(
        "tool_web_network_invalid",
        "Tool web proxy configuration was invalid",
        false,
      );
    }
    const proxy = `http://${webProxy.host}:${String(webProxy.port)}`;
    const directPrivateHosts = directPrivateCidrs.flatMap((cidr) => {
      const [address, prefixText] = cidr.split("/");
      const octets = address!.split(".").map(Number);
      if (octets.length !== 4 || octets.some((octet) => octet < 0 || octet > 255)) {
        throw new ToolWorkerError(
          "tool_web_network_invalid",
          "Tool web proxy configuration was invalid",
          false,
        );
      }
      const prefix = Number(prefixText);
      const base =
        (octets[0]! * 2 ** 24 + octets[1]! * 2 ** 16 + octets[2]! * 2 ** 8 + octets[3]!) >>> 0;
      const count = 2 ** (32 - prefix);
      return Array.from({ length: count }, (_, offset) => {
        const value = (base + offset) >>> 0;
        return [24, 16, 8, 0].map((shift) => String((value >>> shift) & 0xff)).join(".");
      });
    });
    const noProxy = [loopbackNoProxy, ...directPrivateCidrs, ...directPrivateHosts].join(",");
    proxyEnvironment = {
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      NODE_USE_ENV_PROXY: "1",
      NO_PROXY: noProxy,
      no_proxy: noProxy,
    };
  }
  return {
    PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
    HOME: "/tmp/pi-cloud-tool-home",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: `${gitCredentialRoot}/.gitconfig`,
    // A persistent Volume root may have different ownership from the Tool UID.
    // Trust only this admitted working directory, never all repositories.
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: TOOL_WORKSPACE_DIRECTORY,
    GIT_CONFIG_KEY_1: "credential.helper",
    GIT_CONFIG_VALUE_1: `store --file=${gitCredentials}`,
    GIT_CONFIG_KEY_2: "credential.useHttpPath",
    GIT_CONFIG_VALUE_2: "false",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "/bin/false",
    GIT_LFS_SKIP_SMUDGE: "1",
    ...proxyEnvironment,
  };
}

function isInsideWorkspace(path: string, workspaceDirectory = TOOL_WORKSPACE_DIRECTORY): boolean {
  const fromRoot = relative(resolve(workspaceDirectory), path);
  return (
    fromRoot === "" ||
    (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot))
  );
}

export function resolveToolWorkspacePath(
  input: string,
  workspaceDirectory = TOOL_WORKSPACE_DIRECTORY,
): string {
  if (
    input.length < 1 ||
    input.length > 4_096 ||
    /[\u0000-\u001f\u007f]/.test(input) ||
    input.includes("\\")
  ) {
    throw new ToolWorkerError("invalid_tool_path", "Tool path is invalid");
  }
  const workspaceRoot = resolve(workspaceDirectory);
  const resolved = resolve(workspaceRoot, input);
  if (!isInsideWorkspace(resolved, workspaceRoot)) {
    throw new ToolWorkerError("tool_path_escape", "Tool path escaped the workspace");
  }
  return resolved;
}

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

async function assertRealPathInsideWorkspace(
  path: string,
  workspaceDirectory = TOOL_WORKSPACE_DIRECTORY,
): Promise<void> {
  const canonical = await realpath(path).catch((error: unknown) => {
    throw isMissing(error)
      ? new ToolWorkerError("tool_path_missing", "Tool path does not exist")
      : error;
  });
  if (!isInsideWorkspace(canonical, workspaceDirectory)) {
    throw new ToolWorkerError("tool_path_escape", "Tool path escaped the workspace");
  }
}

export async function validateAttachedWorkspaceRoot(
  path = TOOL_WORKSPACE_DIRECTORY,
  requireMountPoint = false,
): Promise<void> {
  const metadata = await lstat(path).catch(() => undefined);
  const canonical = await realpath(path).catch(() => undefined);
  const mountInfo = requireMountPoint
    ? await readFile("/proc/self/mountinfo", "utf8").catch(() => "")
    : "";
  const mounted =
    !requireMountPoint ||
    mountInfo.split("\n").some((line) => {
      const mountPath = line.split(" ")[4];
      return mountPath?.replaceAll("\\040", " ").replaceAll("\\134", "\\") === resolve(path);
    });
  if (
    metadata === undefined ||
    canonical === undefined ||
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    canonical !== resolve(path) ||
    !mounted
  ) {
    throw new ToolWorkerError(
      "workspace_attach_invalid",
      "Preserved Tool workspace could not be attached",
      false,
    );
  }
}

async function assertNoFinalSymlink(path: string): Promise<void> {
  const metadata = await lstat(path).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  if (metadata?.isSymbolicLink()) {
    throw new ToolWorkerError("tool_symlink_rejected", "Tool path was a symbolic link");
  }
}

export async function readWorkspaceFile(
  path: string,
  workspaceDirectory = TOOL_WORKSPACE_DIRECTORY,
  maximumBytes = MAX_TOOL_MUTATION_FILE_BYTES,
): Promise<{ content: Buffer; sha256: string }> {
  const target = resolveToolWorkspacePath(path, workspaceDirectory);
  await assertNoFinalSymlink(target);
  await assertRealPathInsideWorkspace(dirname(target), workspaceDirectory);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new ToolWorkerError("tool_file_unavailable", "Tool file could not be read");
  });
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > maximumBytes) {
      throw new ToolWorkerError("tool_file_limit", "Tool file is outside its byte limit");
    }
    const content = await handle.readFile();
    if (content.byteLength > maximumBytes) {
      throw new ToolWorkerError("tool_file_limit", "Tool file is outside its byte limit");
    }
    return {
      content,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

type WorkspaceFileRange = {
  content: Buffer;
  startLine: number;
  endLine: number;
  nextOffsetLine?: number;
  firstLineBytes?: number;
};

/** Match Pi's TextDecoder + split("\n") while retaining bounded streamed reads. */
async function* nativeTextLines(stream: AsyncIterable<string | Buffer>): AsyncGenerator<string> {
  let first = true;
  let parts: string[] = [];
  for await (const chunk of stream) {
    let text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
    if (first && text.length) {
      first = false;
      if (text.startsWith("\uFEFF")) text = text.slice(1);
    }
    let start = 0;
    let end = text.indexOf("\n");
    while (end >= 0) {
      parts.push(text.slice(start, end));
      yield parts.join("");
      parts = [];
      start = end + 1;
      end = text.indexOf("\n", start);
    }
    if (start < text.length) parts.push(text.slice(start));
  }
  // split("\n") retains an empty final line, including for an empty file.
  yield parts.join("");
}

export async function readWorkspaceFileRange(
  path: string,
  offsetLine: number,
  limitLines: number,
  workspaceDirectory = TOOL_WORKSPACE_DIRECTORY,
  maximumBytes = MAX_TOOL_READ_RANGE_BYTES,
): Promise<WorkspaceFileRange> {
  const target = resolveToolWorkspacePath(path, workspaceDirectory);
  await assertNoFinalSymlink(target);
  await assertRealPathInsideWorkspace(dirname(target), workspaceDirectory);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new ToolWorkerError("tool_file_unavailable", "Tool file could not be read");
  });
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_TOOL_RANGE_FILE_BYTES) {
      throw new ToolWorkerError("tool_file_limit", "Tool file is outside its ranged-read limit");
    }
    const stream = handle.createReadStream({ autoClose: false, encoding: "utf8" });
    const selected: string[] = [];
    let currentLine = 0;
    let selectedBytes = 0;
    let nextOffsetLine: number | undefined;
    let firstLineBytes: number | undefined;
    try {
      for await (const line of nativeTextLines(stream)) {
        currentLine += 1;
        if (currentLine < offsetLine) continue;
        const lineBytes = Buffer.byteLength(line, "utf8");
        const separatorBytes = selected.length === 0 ? 0 : 1;
        if (selected.length === 0 && lineBytes > maximumBytes) {
          firstLineBytes = lineBytes;
          break;
        }
        if (
          selected.length >= limitLines ||
          selectedBytes + separatorBytes + lineBytes > maximumBytes
        ) {
          nextOffsetLine = currentLine;
          break;
        }
        selected.push(line);
        selectedBytes += separatorBytes + lineBytes;
      }
    } finally {
      stream.destroy();
    }
    if (currentLine < offsetLine) {
      throw new ToolWorkerError(
        "tool_read_offset_out_of_range",
        `Read offset ${offsetLine} is beyond the end of the file`,
      );
    }
    return {
      content: Buffer.from(selected.join("\n"), "utf8"),
      startLine: offsetLine,
      endLine: firstLineBytes === undefined ? offsetLine + selected.length - 1 : offsetLine,
      ...(nextOffsetLine === undefined ? {} : { nextOffsetLine }),
      ...(firstLineBytes === undefined ? {} : { firstLineBytes }),
    };
  } finally {
    await handle.close();
  }
}

export function terminateProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error: unknown) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return;
      }
    }
  }
  child.kill(signal);
}

/**
 * Wait for the foreground shell, not every descendant that inherited its pipes.
 * A quiet background service may keep stdout/stderr open after Bash exits; the
 * short idle grace preserves trailing foreground output without turning that
 * service into a permanently running Tool call.
 */
export function waitForShellProcess(child: ChildProcess): Promise<number | null> {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let exited = false;
    let exitCode: number | null = null;
    let idleTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
    };
    const finalize = (code: number | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolvePromise(code);
    };
    const maybeFinalize = (): void => {
      if (exited && stdoutEnded && stderrEnded) finalize(exitCode);
    };
    const armIdleTimer = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => finalize(exitCode), SHELL_EXIT_STDIO_GRACE_MS);
      idleTimer.unref();
    };
    const onData = (): void => {
      if (exited && !settled) armIdleTimer();
    };
    const onStdoutEnd = (): void => {
      stdoutEnded = true;
      maybeFinalize();
    };
    const onStderrEnd = (): void => {
      stderrEnded = true;
      maybeFinalize();
    };
    const onError = (error: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    };
    const onExit = (code: number | null): void => {
      exited = true;
      exitCode = code;
      maybeFinalize();
      if (!settled) armIdleTimer();
    };
    const onClose = (code: number | null): void => finalize(code);

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}

export function toolOperationFailure(
  request: ToolSandboxOperationRequest,
  error: unknown,
): ToolSandboxOperationResponse {
  const failure =
    error instanceof ToolWorkerError
      ? error
      : new ToolWorkerError("tool_operation_failed", "Tool operation failed", true);
  return {
    toolBrokerProtocolVersion: 1,
    type: "tool_sandbox.operation_failed",
    activationId: request.activationId,
    operationId: request.operationId,
    code: failure.code,
    message: failure.message,
    retryable: failure.retryable,
  };
}

export async function seedToolWorkspace(
  workspaceSeed: Parameters<typeof decodeWorkspaceBlob>[0] | undefined,
): Promise<void> {
  if (workspaceSeed === undefined) {
    const files: { path: string; executable: boolean; content: Uint8Array }[] = [];
    for (const entry of await readdir(SAMPLE_JAVA_FIXTURE, {
      recursive: true,
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue;
      const source = join(entry.parentPath, entry.name);
      files.push({
        path: relative(SAMPLE_JAVA_FIXTURE, source),
        content: await readFile(source),
        executable: ((await lstat(source)).mode & 0o111) !== 0,
      });
    }
    await initializeWorkspaceSeed(TOOL_WORKSPACE_DIRECTORY, createWorkspaceSeed(files));
  } else {
    await initializeWorkspaceSeed(TOOL_WORKSPACE_DIRECTORY, decodeWorkspaceBlob(workspaceSeed));
  }
}

export async function initializeToolExecution(
  message: Extract<ToolWorkerInput, { type: "worker.initialize" }>,
): Promise<EnvironmentToolchainReport> {
  await selectToolRoot(message.toolRoot);
  safeToolEnvironment(message.webProxy);
  const environment = await validateToolEnvironment(message.environment);
  const seed = message.workspaceSeed.kind === "bundle" ? message.workspaceSeed.bundle : undefined;
  await seedToolWorkspace(seed);
  const recipeWebProxy = dependencyRecipeWebProxy(message.environment, message.webProxy);
  environment.recipeCommands = await executeEnvironmentRecipe(
    message.environment,
    TOOL_WORKSPACE_DIRECTORY,
    { ...(recipeWebProxy === undefined ? {} : { webProxy: recipeWebProxy }) },
  );
  return environment;
}

async function selectToolRoot(toolRoot: string): Promise<void> {
  const requestedToolRoot = resolve("/", toolRoot);
  const canonicalToolRoot = await realpath(requestedToolRoot).catch(() => undefined);
  const toolRootMetadata =
    canonicalToolRoot === undefined
      ? undefined
      : await lstat(canonicalToolRoot).catch(() => undefined);
  if (
    canonicalToolRoot === undefined ||
    toolRootMetadata === undefined ||
    !toolRootMetadata.isDirectory()
  ) {
    throw new ToolWorkerError(
      "tool_root_unavailable",
      "Selected machine working directory was unavailable",
      false,
    );
  }
  TOOL_WORKSPACE_DIRECTORY = canonicalToolRoot;
}

function validateAttachedInitialization(): Promise<void> {
  return validateAttachedWorkspaceRoot(
    TOOL_WORKSPACE_DIRECTORY,
    TOOL_WORKSPACE_DIRECTORY === "/workspace",
  );
}

export async function attachToolExecution(
  message: Extract<ToolWorkerInput, { type: "worker.initialize" }>,
): Promise<string> {
  await selectToolRoot(message.toolRoot);
  safeToolEnvironment(message.webProxy);
  await validateAttachedInitialization();
  return TOOL_WORKSPACE_DIRECTORY;
}
