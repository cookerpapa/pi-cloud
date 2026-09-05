import {
  canonicalEnvironmentRecipeJson,
  isExpectedDefaultToolchain,
  MAX_TOOL_COMMAND_BYTES,
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
import { decodeWorkspaceBlob, restoreWorkspaceSeed } from "@pi-cloud/workspace-runtime";
import { spawn, execFile, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
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
    // Kubernetes emptyDir volumes are mounted with root ownership and the
    // Pod's fsGroup, even though every process and repository entry is owned
    // by uid 1000. Pin Git's trust exception to the one fixed workspace root;
    // never accept a user-controlled path here.
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

function byteLengthWithin(value: string, maximum: number): boolean {
  return Buffer.byteLength(value, "utf8") <= maximum;
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

async function ensureWorkspaceDirectory(
  path: string,
  workspaceDirectory = TOOL_WORKSPACE_DIRECTORY,
): Promise<void> {
  const relativePath = relative(workspaceDirectory, path);
  if (relativePath === "") return;
  let current = workspaceDirectory;
  for (const segment of relativePath.split(sep)) {
    current = join(current, segment);
    let metadata = await lstat(current).catch((error: unknown) => {
      if (isMissing(error)) return undefined;
      throw error;
    });
    if (metadata === undefined) {
      await mkdir(current, { mode: 0o755 }).catch((error: unknown) => {
        if (
          typeof error !== "object" ||
          error === null ||
          !("code" in error) ||
          error.code !== "EEXIST"
        )
          throw error;
      });
      metadata = await lstat(current);
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new ToolWorkerError(
        "tool_directory_rejected",
        "Tool directory path contains a link or non-directory",
      );
    }
  }
}

export async function readWorkspaceFile(
  path: string,
  workspaceDirectory = TOOL_WORKSPACE_DIRECTORY,
): Promise<{ content: Buffer; sha256: string }> {
  const target = resolveToolWorkspacePath(path, workspaceDirectory);
  await assertNoFinalSymlink(target);
  await assertRealPathInsideWorkspace(dirname(target), workspaceDirectory);
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new ToolWorkerError("tool_file_unavailable", "Tool file could not be read");
  });
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_TOOL_MUTATION_FILE_BYTES) {
      throw new ToolWorkerError("tool_file_limit", "Tool file is outside its byte limit");
    }
    const content = await handle.readFile();
    if (content.byteLength > MAX_TOOL_MUTATION_FILE_BYTES) {
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

export async function readWorkspaceFileRange(
  path: string,
  offsetLine: number,
  limitLines: number,
  workspaceDirectory = TOOL_WORKSPACE_DIRECTORY,
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
    if (metadata.size === 0 && offsetLine === 1) {
      return { content: Buffer.alloc(0), startLine: 1, endLine: 1 };
    }
    const stream = handle.createReadStream({ autoClose: false, encoding: "utf8" });
    const lines = createInterface({ input: stream, crlfDelay: Infinity });
    const selected: string[] = [];
    let currentLine = 0;
    let selectedBytes = 0;
    let nextOffsetLine: number | undefined;
    let firstLineBytes: number | undefined;
    try {
      for await (const line of lines) {
        currentLine += 1;
        if (currentLine < offsetLine) continue;
        const lineBytes = Buffer.byteLength(line, "utf8");
        const separatorBytes = selected.length === 0 ? 0 : 1;
        if (selected.length === 0 && lineBytes > MAX_TOOL_READ_RANGE_BYTES) {
          firstLineBytes = lineBytes;
          break;
        }
        if (
          selected.length >= limitLines ||
          selectedBytes + separatorBytes + lineBytes > MAX_TOOL_READ_RANGE_BYTES
        ) {
          nextOffsetLine = currentLine;
          break;
        }
        selected.push(line);
        selectedBytes += separatorBytes + lineBytes;
      }
    } finally {
      lines.close();
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

async function currentWorkspaceFileSha256(target: string): Promise<string> {
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => {
    throw new ToolWorkerError("tool_edit_conflict", "Tool file changed before it was written");
  });
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > MAX_TOOL_MUTATION_FILE_BYTES) {
      throw new ToolWorkerError("tool_file_limit", "Tool file is outside its byte limit");
    }
    return createHash("sha256")
      .update(await handle.readFile())
      .digest("hex");
  } finally {
    await handle.close();
  }
}

export async function writeWorkspaceFile(
  path: string,
  content: string,
  expectedSha256?: string,
  workspaceDirectory = TOOL_WORKSPACE_DIRECTORY,
): Promise<string> {
  if (!byteLengthWithin(content, MAX_TOOL_MUTATION_FILE_BYTES)) {
    throw new ToolWorkerError("tool_file_limit", "Tool file is outside its byte limit");
  }
  const target = resolveToolWorkspacePath(path, workspaceDirectory);
  await assertNoFinalSymlink(target);
  const parent = dirname(target);
  if (expectedSha256 === undefined) await ensureWorkspaceDirectory(parent, workspaceDirectory);
  await assertRealPathInsideWorkspace(parent, workspaceDirectory);
  if (expectedSha256 !== undefined) {
    const actualSha256 = await currentWorkspaceFileSha256(target);
    if (actualSha256 !== expectedSha256) {
      throw new ToolWorkerError("tool_edit_conflict", "Tool file changed before it was written");
    }
  }
  const existing = await lstat(target).catch((error: unknown) => {
    if (isMissing(error)) return undefined;
    throw error;
  });
  const temporary = join(parent, `.pi-cloud-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      existing === undefined ? 0o644 : existing.mode & 0o777,
    );
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (expectedSha256 !== undefined) {
      const actualSha256 = await currentWorkspaceFileSha256(target);
      if (actualSha256 !== expectedSha256) {
        throw new ToolWorkerError("tool_edit_conflict", "Tool file changed before it was written");
      }
    }
    await rename(temporary, target);
    const directory = await open(parent, constants.O_RDONLY);
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
  return createHash("sha256").update(content, "utf8").digest("hex");
}

async function accessWorkspaceFile(path: string): Promise<void> {
  const target = resolveToolWorkspacePath(path);
  await assertNoFinalSymlink(target);
  await assertRealPathInsideWorkspace(target);
  await access(target, constants.R_OK | constants.W_OK).catch(() => {
    throw new ToolWorkerError("tool_file_unavailable", "Tool file is not accessible");
  });
}

function terminateProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
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

async function executeBash(
  request: Extract<ToolSandboxOperationRequest, { operation: "bash.exec" }>,
  signal: AbortSignal,
  webProxy?: ToolWebProxyBootstrap,
): Promise<Extract<ToolSandboxOperationResponse, { operation: "bash.exec" }>> {
  if (!byteLengthWithin(request.command, MAX_TOOL_COMMAND_BYTES)) {
    throw new ToolWorkerError("tool_command_limit", "Tool command is outside its byte limit");
  }
  const cwd = resolveToolWorkspacePath(request.cwd);
  await assertRealPathInsideWorkspace(cwd);
  const child = spawn("/bin/bash", ["--noprofile", "--norc", "-lc", request.command], {
    cwd,
    detached: process.platform !== "win32",
    env: safeToolEnvironment(webProxy),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const outputChunks: Array<{ stream: "stdout" | "stderr"; data: Buffer }> = [];
  let outputBytes = 0;
  let overflow = false;
  let timedOut = false;
  const append = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    if (overflow) return;
    outputBytes += chunk.byteLength;
    if (outputBytes > MAX_TOOL_OUTPUT_BYTES || outputChunks.length >= 16_384) {
      overflow = true;
      terminateProcessGroup(child, "SIGKILL");
      return;
    }
    const previous = outputChunks.at(-1);
    if (previous?.stream === stream) previous.data = Buffer.concat([previous.data, chunk]);
    else outputChunks.push({ stream, data: Buffer.from(chunk) });
  };
  child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
  const timer = setTimeout(() => {
    timedOut = true;
    terminateProcessGroup(child, "SIGTERM");
    const force = setTimeout(() => terminateProcessGroup(child, "SIGKILL"), 250);
    force.unref();
  }, request.timeoutMs);
  timer.unref();
  const abort = (): void => terminateProcessGroup(child, "SIGTERM");
  signal.addEventListener("abort", abort, { once: true });
  try {
    const code = await waitForShellProcess(child).catch(() => {
      throw new ToolWorkerError("tool_process_failed", "Tool process could not start", true);
    });
    if (overflow) {
      throw new ToolWorkerError("tool_output_limit", "Tool output exceeded its byte limit");
    }
    if (timedOut) throw new ToolWorkerError("tool_timeout", "Tool command timed out", true);
    if (signal.aborted)
      throw new ToolWorkerError("tool_cancelled", "Tool command was cancelled", true);
    const output = Buffer.concat(outputChunks.map((chunk) => chunk.data));
    return {
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.operation_result",
      activationId: request.activationId,
      operationId: request.operationId,
      operation: "bash.exec",
      exitCode: code,
      outputChunks: outputChunks.map((chunk, index) => ({
        seq: index + 1,
        stream: chunk.stream,
        data: chunk.data.toString("base64"),
      })),
      outputSha256: createHash("sha256").update(output).digest("hex"),
    };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

export async function executeToolOperation(
  request: ToolSandboxOperationRequest,
  signal: AbortSignal,
  webProxy?: ToolWebProxyBootstrap,
): Promise<ToolSandboxOperationResponse> {
  if (request.operation === "bash.exec") return executeBash(request, signal, webProxy);
  if (request.operation === "file.read") {
    const file = await readWorkspaceFile(request.path);
    return {
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.operation_result",
      activationId: request.activationId,
      operationId: request.operationId,
      operation: "file.read",
      content: file.content.toString("base64"),
      sha256: file.sha256,
    };
  }
  if (request.operation === "file.read_range") {
    const range = await readWorkspaceFileRange(
      request.path,
      request.offsetLine,
      request.limitLines,
    );
    return {
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.operation_result",
      activationId: request.activationId,
      operationId: request.operationId,
      operation: "file.read_range",
      content: range.content.toString("base64"),
      startLine: range.startLine,
      endLine: range.endLine,
      ...(range.nextOffsetLine === undefined ? {} : { nextOffsetLine: range.nextOffsetLine }),
      ...(range.firstLineBytes === undefined ? {} : { firstLineBytes: range.firstLineBytes }),
    };
  }
  if (request.operation === "file.write") {
    const sha256 = await writeWorkspaceFile(request.path, request.content, request.expectedSha256);
    return {
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.operation_result",
      activationId: request.activationId,
      operationId: request.operationId,
      operation: "file.write",
      sha256,
    };
  }
  if (request.operation === "file.mkdir") {
    await ensureWorkspaceDirectory(resolveToolWorkspacePath(request.path));
  }
  if (request.operation === "file.access") await accessWorkspaceFile(request.path);
  return {
    toolBrokerProtocolVersion: 1,
    type: "tool_sandbox.operation_result",
    activationId: request.activationId,
    operationId: request.operationId,
    operation: request.operation,
  };
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

export async function prepareToolWorkspace(
  workspaceSeed: Parameters<typeof decodeWorkspaceBlob>[0] | undefined,
): Promise<void> {
  const existing = await readdir(TOOL_WORKSPACE_DIRECTORY);
  if (existing.length !== 0) {
    throw new ToolWorkerError("workspace_not_empty", "Tool workspace was not empty");
  }
  if (workspaceSeed === undefined) {
    for (const entry of await readdir(SAMPLE_JAVA_FIXTURE)) {
      await cp(join(SAMPLE_JAVA_FIXTURE, entry), join(TOOL_WORKSPACE_DIRECTORY, entry), {
        recursive: true,
        preserveTimestamps: true,
      });
    }
  } else {
    await restoreWorkspaceSeed(TOOL_WORKSPACE_DIRECTORY, decodeWorkspaceBlob(workspaceSeed));
  }
}

export async function initializeToolExecution(
  message: Extract<ToolWorkerInput, { type: "worker.initialize" }>,
): Promise<EnvironmentToolchainReport> {
  await selectToolRoot(message.toolRoot);
  safeToolEnvironment(message.webProxy);
  const environment = await validateToolEnvironment(message.environment);
  if (message.workspaceAttach === undefined) {
    const seed = message.workspaceSeed.kind === "bundle" ? message.workspaceSeed.bundle : undefined;
    await prepareToolWorkspace(seed);
    const recipeWebProxy = dependencyRecipeWebProxy(message.environment, message.webProxy);
    environment.recipeCommands = await executeEnvironmentRecipe(
      message.environment,
      TOOL_WORKSPACE_DIRECTORY,
      {
        ...(recipeWebProxy === undefined ? {} : { webProxy: recipeWebProxy }),
      },
    );
  } else {
    await validateAttachedInitialization();
    environment.recipeCommands = [...message.workspaceAttach.recipeCommands];
  }
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
): Promise<void> {
  await selectToolRoot(message.toolRoot);
  safeToolEnvironment(message.webProxy);
  await validateAttachedInitialization();
}
