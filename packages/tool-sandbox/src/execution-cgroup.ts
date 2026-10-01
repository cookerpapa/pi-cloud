import { constants } from "node:fs";
import { mkdir, open, readFile, stat, writeFile, rmdir, unlink, readdir } from "node:fs/promises";
import { posix } from "node:path";

const CGROUP_ROOT = "/sys/fs/cgroup";
const LOCATORS = "/run/pi-cloud/tool-scopes";
const MAXIMUM_SCOPES = 4096;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function removeEmptyScope(path: string, id: string): Promise<boolean> {
  if (!/^populated 0$/m.test(await readFile(posix.join(path, "cgroup.events"), "utf8")))
    return false;
  await rmdir(path);
  await unlink(posix.join(LOCATORS, `${id}.json`));
  return true;
}

/** Finished background servers keep their group until they exit. Reap only
 * locators marked after the launcher has left, never a group still being entered. */
async function reapFinishedScopes(parent: string): Promise<void> {
  for (const name of await readdir(parent)) {
    if (!UUID.test(name)) continue;
    try {
      const locator = JSON.parse(await readFile(posix.join(LOCATORS, `${name}.json`), "utf8"));
      if (locator.finished === true && locator.path === posix.join(parent, name))
        await removeEmptyScope(locator.path, name);
    } catch (error) {
      if (!["ENOENT", "EBUSY", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
    }
  }
}

function identity(id: string): string {
  if (!UUID.test(id)) throw new Error("Invalid execution scope identity");
  return id.toLowerCase();
}

export function executionCgroupPath(operationId: string, membership: string): string {
  const parent = membership
    .split("\n")
    .find((line) => line.startsWith("0::"))
    ?.slice(3);
  if (!parent?.startsWith("/") || parent.includes("..") || /[\u0000-\u0020\u007f\\]/u.test(parent))
    throw new Error("Unified execution cgroup is unavailable");
  return posix.join(CGROUP_ROOT, parent.slice(1), "pi-cloud-tools", identity(operationId));
}

function requireRoot(): void {
  if (process.getuid?.() !== 0)
    throw new Error("Execution scope control requires trusted guest root");
}

/** Native containerd exec has completed its own cgroup placement before this
 * launcher runs. Enter before starting any untrusted Tool descendants. */
export async function enterExecutionCgroup(operationId: string, inputPath: string): Promise<void> {
  requireRoot();
  const id = identity(operationId);
  const path = executionCgroupPath(id, await readFile("/proc/self/cgroup", "utf8"));
  await mkdir(LOCATORS, { recursive: true, mode: 0o700 });
  const parent = posix.dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  await writeFile(posix.join(parent, "cgroup.max.descendants"), String(MAXIMUM_SCOPES));
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOSPC") throw error;
    await reapFinishedScopes(parent);
    await mkdir(path, { mode: 0o700 });
  }
  await stat(posix.join(path, "cgroup.kill"));
  // Root-owned identity is needed while native execution can require stopping.
  // The boot-scoped Cube registry owns deduplication; boot replacement does not
  // resume old commands. This locator contains no result or history.
  const locator = await open(
    posix.join(LOCATORS, `${id}.json`),
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await locator.writeFile(JSON.stringify({ version: 1, path, inputPath }));
    await locator.sync();
  } finally {
    await locator.close();
  }
  await writeFile(posix.join(path, "cgroup.procs"), String(process.pid));
}

/** Called after the fixed child exits. Empty groups are not lifetime tombstones. */
export async function finishExecutionCgroup(operationId: string): Promise<void> {
  requireRoot();
  const id = identity(operationId);
  const locatorPath = posix.join(LOCATORS, `${id}.json`);
  const locator = JSON.parse(await readFile(locatorPath, "utf8")) as {
    path: string;
    inputPath: string;
  };
  const parent = posix.dirname(posix.dirname(locator.path));
  await writeFile(posix.join(parent, "cgroup.procs"), String(process.pid));
  if (!(await removeEmptyScope(locator.path, id)))
    await writeFile(locatorPath, JSON.stringify({ version: 1, ...locator, finished: true }), {
      mode: 0o600,
    });
}

/** Only call after the native main process has exited. An empty observation
 * alone cannot exclude a launcher that has not entered its group yet. */
export async function stopExecutionCgroup(
  operationId: string,
  timeoutMs = 5000,
): Promise<{ empty: true; inputPath?: string }> {
  requireRoot();
  const id = identity(operationId);
  let handle;
  try {
    handle = await open(
      posix.join(LOCATORS, `${id}.json`),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { empty: true };
    throw error;
  }
  let locator: { version: number; path: string; inputPath: string };
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.uid !== 0 || info.size > 8192)
      throw new Error("Invalid execution scope locator");
    locator = JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
  if (
    locator.version !== 1 ||
    !locator.path.startsWith(CGROUP_ROOT + "/") ||
    !locator.path.endsWith(`/pi-cloud-tools/${id}`) ||
    locator.path.includes("..") ||
    !/^\/tmp\/pi-cloud-envd-[0-9a-f-]{36}\.json$/u.test(locator.inputPath)
  )
    throw new Error("Execution scope locator changed");
  const events = posix.join(locator.path, "cgroup.events");
  try {
    await writeFile(posix.join(locator.path, "cgroup.kill"), "1");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        await stat(locator.path);
      } catch (missing) {
        if ((missing as NodeJS.ErrnoException).code === "ENOENT")
          return { empty: true, inputPath: locator.inputPath };
        throw missing;
      }
    }
    throw error;
  }
  const end = performance.now() + timeoutMs;
  do {
    if (/^populated 0$/m.test(await readFile(events, "utf8"))) {
      await removeEmptyScope(locator.path, id);
      return { empty: true, inputPath: locator.inputPath };
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (performance.now() < end);
  throw new Error("Execution scope stopping could not be confirmed");
}
