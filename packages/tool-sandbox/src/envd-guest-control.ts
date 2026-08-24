import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chown, lstat, mkdir, open, readFile, readdir, realpath, rmdir } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const TOOL_UID = 1_000;
type ProcessIdentity = Readonly<{ pid: number; startTime: string }>;

async function input(): Promise<Record<string, unknown>> {
  const path = process.argv[2];
  if (path === undefined || !/^\/tmp\/pi-cloud-envd-[0-9a-f-]{36}\.json$/u.test(path)) {
    throw new Error("Guest control input path was invalid");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > 1 * 1_024 * 1_024) {
      throw new Error("Guest control input was invalid");
    }
    const value = JSON.parse((await handle.readFile()).toString("utf8")) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("Guest control input was invalid");
    }
    return value as Record<string, unknown>;
  } finally {
    await handle.close();
  }
}

async function processStartTime(pid: number): Promise<string | undefined> {
  const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8").catch(() => undefined);
  if (stat === undefined) return undefined;
  const commandEnd = stat.lastIndexOf(")");
  if (commandEnd < 1) return undefined;
  const value = stat
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/u)[19];
  return value !== undefined && /^[0-9]+$/u.test(value) ? value : undefined;
}

async function userProcesses(): Promise<ProcessIdentity[]> {
  return (
    await Promise.all(
      (await readdir("/proc"))
        .filter((entry) => /^[1-9][0-9]*$/u.test(entry))
        .map(async (entry): Promise<ProcessIdentity | undefined> => {
          const pid = Number(entry);
          const status = await readFile(`/proc/${entry}/status`, "utf8").catch(() => undefined);
          const uid = status?.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)$/mu);
          if (
            !Number.isSafeInteger(pid) ||
            uid?.slice(1).every((value) => Number(value) !== TOOL_UID)
          ) {
            return undefined;
          }
          const startTime = await processStartTime(pid);
          return startTime === undefined ? undefined : { pid, startTime };
        }),
    )
  )
    .filter((entry): entry is ProcessIdentity => entry !== undefined)
    .sort((left, right) => left.pid - right.pid);
}

async function freeze(path: string): Promise<ProcessIdentity[]> {
  const processes = await userProcesses();
  try {
    for (const identity of processes) {
      if ((await processStartTime(identity.pid)) === identity.startTime) {
        process.kill(identity.pid, "SIGSTOP");
      }
    }
    const deadline = Date.now() + 1_000;
    for (;;) {
      const states = await Promise.all(
        processes.map(async (identity) => {
          if ((await processStartTime(identity.pid)) !== identity.startTime) return "gone";
          const status = await readFile(`/proc/${String(identity.pid)}/status`, "utf8").catch(
            () => "",
          );
          if (status === "" || /^State:\s+(?:Z|X|x)\b/mu.test(status)) return "gone";
          return /^State:\s+(?:T|t)\b/mu.test(status) ? "stopped" : "running";
        }),
      );
      if (states.every((state) => state !== "running")) break;
      if (Date.now() >= deadline) throw new Error("Guest processes could not be quiesced");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    }
    await exec("/bin/sync", ["-f", path], { timeout: 10_000 });
    return processes;
  } catch (error: unknown) {
    await thaw(processes).catch(() => undefined);
    throw error;
  }
}

function processList(value: unknown): ProcessIdentity[] {
  if (!Array.isArray(value) || value.length > 512) throw new Error("Process list was invalid");
  return value.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("Process identity was invalid");
    }
    const candidate = entry as Record<string, unknown>;
    if (
      !Number.isSafeInteger(candidate.pid) ||
      (candidate.pid as number) < 1 ||
      typeof candidate.startTime !== "string" ||
      !/^[0-9]+$/u.test(candidate.startTime)
    ) {
      throw new Error("Process identity was invalid");
    }
    return { pid: candidate.pid as number, startTime: candidate.startTime };
  });
}

async function thaw(processes: readonly ProcessIdentity[]): Promise<number> {
  let resumed = 0;
  for (const identity of processes) {
    if ((await processStartTime(identity.pid)) !== identity.startTime) continue;
    try {
      process.kill(identity.pid, "SIGCONT");
      resumed++;
    } catch (error: unknown) {
      if (
        typeof error !== "object" ||
        error === null ||
        !("code" in error) ||
        error.code !== "ESRCH"
      ) {
        throw error;
      }
    }
  }
  return resumed;
}

async function evidence(): Promise<Record<string, unknown>> {
  const [imageRevision, kernelRelease, cpuInfo, memory, processStatus, mountInfo] =
    await Promise.all([
      readFile("/opt/pi-cloud/image-revision", "utf8"),
      readFile("/proc/sys/kernel/osrelease", "utf8"),
      readFile("/proc/cpuinfo", "utf8"),
      readFile("/proc/meminfo", "utf8"),
      readFile(`/proc/${String(process.pid)}/status`, "utf8"),
      readFile("/proc/self/mountinfo", "utf8"),
    ]);
  const cpuCount = cpuInfo.split("\n").filter((line) => /^processor\s*:/u.test(line)).length;
  const memoryBytes = Number(memory.match(/^MemTotal:\s+(\d+)\s+kB$/mu)?.[1] ?? 0) * 1_024;
  const capabilities = processStatus.match(/^CapEff:\s+([0-9a-fA-F]+)$/mu)?.[1]?.toLowerCase();
  const rootMount = mountInfo
    .split("\n")
    .map((line) => line.split(" "))
    .find((fields) => fields[4] === "/");
  const ipAddress = Object.values(networkInterfaces())
    .flatMap((addresses) => addresses ?? [])
    .find((address) => address.family === "IPv4" && !address.internal)?.address;
  if (
    cpuCount < 1 ||
    !Number.isSafeInteger(memoryBytes) ||
    capabilities === undefined ||
    rootMount === undefined ||
    ipAddress === undefined
  ) {
    throw new Error("Guest evidence was invalid");
  }
  return {
    controlProtocolVersion: 2,
    imageRevision: imageRevision.trim(),
    kernelRelease: kernelRelease.trim(),
    cpuCount,
    memoryBytes,
    uid: process.geteuid?.() ?? -1,
    gid: process.getegid?.() ?? -1,
    hypervisorFlag: /(?:^|\s)(?:flags|Features)\s*:.*(?:^|\s)hypervisor(?:\s|$)/mu.test(cpuInfo),
    noNewPrivileges: /^NoNewPrivs:\s+1$/mu.test(processStatus),
    effectiveCapabilities: capabilities,
    readOnlyRootFilesystem: rootMount[5]?.split(",").includes("ro") ?? false,
    supervisorUid: 0,
    supervisorGid: 0,
    ipAddress,
  };
}

function absolutePath(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 4_096 ||
    !value.startsWith("/") ||
    /[\u0000-\u001f\u007f]/u.test(value) ||
    /(?:^|\/)\.\.?($|\/)/u.test(value)
  ) {
    throw new Error("Guest path was invalid");
  }
  return value;
}

async function listDirectory(path: string): Promise<Record<string, unknown>> {
  const canonical = await realpath(path);
  const directory = await lstat(canonical);
  if (!directory.isDirectory()) throw new Error("Guest directory was unavailable");
  const names = await readdir(canonical);
  if (names.length > 1_000) throw new Error("Guest directory exceeded its entry limit");
  const entries = await Promise.all(
    names.map(async (name) => {
      const child = resolve(canonical, name);
      const metadata = await lstat(child);
      const kind = metadata.isDirectory()
        ? "directory"
        : metadata.isFile()
          ? "file"
          : metadata.isSymbolicLink()
            ? "symlink"
            : "other";
      return { name, path: child, kind, sizeBytes: metadata.size };
    }),
  );
  entries.sort((left, right) => left.name.localeCompare(right.name));
  return { path: canonical, entries };
}

async function createDirectory(path: string, name: unknown): Promise<Record<string, unknown>> {
  if (
    typeof name !== "string" ||
    name.length < 1 ||
    name.length > 128 ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    /[\u0000-\u001f\u007f]/u.test(name)
  ) {
    throw new Error("Guest directory name was invalid");
  }
  const parent = await realpath(path);
  if (!(await lstat(parent)).isDirectory())
    throw new Error("Guest parent directory was unavailable");
  const target = resolve(parent, name);
  await mkdir(target, { mode: 0o700 });
  await chown(target, TOOL_UID, TOOL_UID);
  return listDirectory(parent);
}

async function prepareExclusiveMachine(): Promise<Record<string, unknown>> {
  await mkdir("/home/user", { recursive: true, mode: 0o700 });
  await chown("/home/user", TOOL_UID, TOOL_UID);
  const legacyWorkspace = await lstat("/workspace").catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (legacyWorkspace !== undefined) {
    if (!legacyWorkspace.isDirectory() || (await readdir("/workspace")).length !== 0) {
      throw new Error("Legacy Workspace path was not an empty directory");
    }
    await rmdir("/workspace");
  }
  return { home: "/home/user", legacyWorkspaceRemoved: true };
}

const request = await input();
let result: Record<string, unknown>;
if (request.mode === "evidence" && Object.keys(request).length === 1) {
  result = { evidence: await evidence() };
} else if (request.mode === "freeze" && Object.keys(request).sort().join(",") === "mode,path") {
  result = { processes: await freeze(absolutePath(request.path)) };
} else if (request.mode === "thaw" && Object.keys(request).sort().join(",") === "mode,processes") {
  result = { resumed: await thaw(processList(request.processes)) };
} else if (
  request.mode === "list_directory" &&
  Object.keys(request).sort().join(",") === "mode,path"
) {
  result = await listDirectory(absolutePath(request.path));
} else if (
  request.mode === "create_directory" &&
  Object.keys(request).sort().join(",") === "mode,name,path"
) {
  result = await createDirectory(absolutePath(request.path), request.name);
} else if (request.mode === "prepare_exclusive_machine" && Object.keys(request).length === 1) {
  result = await prepareExclusiveMachine();
} else {
  throw new Error("Guest control request was invalid");
}
process.stdout.write(`${JSON.stringify(result)}\n`);
