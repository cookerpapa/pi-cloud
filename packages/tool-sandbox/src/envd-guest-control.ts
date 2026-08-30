import { constants } from "node:fs";
import { chown, lstat, mkdir, open, readFile, readdir, realpath, rmdir } from "node:fs/promises";
import { networkInterfaces } from "node:os";
import { resolve } from "node:path";
const TOOL_UID = 1_000;

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
  const elasticRoot = await lstat("/workspace").catch((error: unknown) => {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  if (elasticRoot !== undefined) {
    if (!elasticRoot.isDirectory() || (await readdir("/workspace")).length !== 0) {
      throw new Error("Exclusive machine received a non-empty elastic Workspace root");
    }
    await rmdir("/workspace");
  }
  return { home: "/home/user" };
}

const request = await input();
let result: Record<string, unknown>;
if (request.mode === "evidence" && Object.keys(request).length === 1) {
  result = { evidence: await evidence() };
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
