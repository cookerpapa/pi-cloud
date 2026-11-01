import { constants } from "node:fs";
import { open, readdir, lstat, mkdir, rename, rm, unlink, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { UploadStagingArea } from "@pi-cloud/workspace-runtime";
import { validSkillPath } from "@pi-cloud/protocol/skills";

const part = /^\.part-[0-9a-f-]{36}$/;
const at = (directory: FileHandle, name: string) => `/proc/self/fd/${directory.fd}/${name}`;
type Receipt = {
  version: 1;
  directory: string;
  files: Array<{ path: string; bytes: number; sha256: string }>;
};
const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function reap(directory: FileHandle) {
  // Atomic journal writes use the same reserved temporary namespace as uploads.
  for (const name of await readdir(at(directory, "")))
    if (part.test(name)) {
      if (!(await lstat(at(directory, name))).isFile())
        throw new Error("Skill staging identity changed");
      await unlink(at(directory, name));
    }
  const journal = await open(
    at(directory, "pending.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  ).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!journal) return;
  let receipt: Receipt;
  try {
    const stat = await journal.stat();
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error("Invalid Skill staging journal");
    receipt = JSON.parse(await journal.readFile("utf8"));
  } finally {
    await journal.close();
  }
  if (
    receipt.version !== 1 ||
    !/^prepare-[0-9a-f-]{36}$/.test(receipt.directory) ||
    !Array.isArray(receipt.files) ||
    receipt.files.length > 512 ||
    receipt.files.some(
      (file) =>
        !validSkillPath(file.path) ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0 ||
        !/^[a-f0-9]{64}$/.test(file.sha256),
    )
  )
    throw new Error("Invalid Skill staging journal");
  const expected = new Map(receipt.files.map((file) => [file.path, file]));
  if (expected.size !== receipt.files.length) throw new Error("Invalid Skill staging journal");
  const directories = new Set<string>();
  for (const file of expected.keys()) {
    const segments = file.split("/");
    for (let i = 1; i < segments.length; i++) directories.add(segments.slice(0, i).join("/"));
  }
  const root = at(directory, receipt.directory);
  async function verify(path: string, prefix = "") {
    if (!(await lstat(path)).isDirectory())
      throw new Error("Skill staging was modified; preserve it for inspection");
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const name = prefix + entry.name,
        child = join(path, entry.name),
        file = expected.get(name);
      if (entry.isDirectory() && directories.has(name)) await verify(child, name + "/");
      else if (entry.isFile() && file) {
        const handle = await open(
          child,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        try {
          const stat = await handle.stat();
          if (
            !stat.isFile() ||
            stat.size !== file.bytes ||
            hash(await handle.readFile()) !== file.sha256
          )
            throw new Error("Skill staging was modified; preserve it for inspection");
        } finally {
          await handle.close();
        }
      } else if (!(entry.isFile() && part.test(entry.name)))
        throw new Error("Skill staging was modified; preserve it for inspection");
    }
  }
  const exists = await lstat(root).then(
    () => true,
    (error) => {
      if (error.code === "ENOENT") return false;
      throw error;
    },
  );
  if (exists) {
    await verify(root);
    await rm(root, { recursive: true });
  }
  await unlink(at(directory, "pending.json"));
  await directory.sync();
}

/** One OS-held staging lifetime per Workspace; no PG task or PID liveness test.
 * Final package paths live outside this managed area and are never reaped here. */
export async function withSkillStaging<T>(
  parent: string,
  files: ReadonlyMap<string, Buffer>,
  publish: (path: string) => Promise<T>,
  reuse: () => Promise<T | undefined>,
) {
  const area = new UploadStagingArea(join(parent, "skill-staging"));
  await area.prepare();
  const result = await area.exclusive(async (directory) => {
    await reap(directory);
    const previous = await reuse();
    if (previous !== undefined) return previous;
    const receipt: Receipt = {
      version: 1,
      directory: `prepare-${randomUUID()}`,
      files: [...files].map(([path, bytes]) => ({
        path,
        bytes: bytes.length,
        sha256: hash(bytes),
      })),
    };
    const temporary = at(directory, `.part-${randomUUID()}`);
    const journal = await open(temporary, "wx", 0o600);
    try {
      await journal.writeFile(JSON.stringify(receipt));
      await journal.sync();
    } finally {
      await journal.close();
    }
    await rename(temporary, at(directory, "pending.json"));
    await directory.sync(); // Receipt precedes any directory whose bytes might outlive the process.
    const staging = at(directory, receipt.directory);
    try {
      await mkdir(staging, { mode: 0o700 });
      for (const [path, bytes] of files) {
        const target = join(staging, path);
        await mkdir(dirname(target), { recursive: true });
        const partPath = join(dirname(target), `.part-${randomUUID()}`);
        await (async () => {
          const file = await open(partPath, "wx", 0o644);
          try {
            await file.writeFile(bytes);
          } finally {
            await file.close();
          }
        })();
        await rename(partPath, target);
      }
      return await publish(staging);
    } finally {
      await reap(directory);
    }
  }, 30_000);
  if (!result)
    throw new Error("Skill preparation is busy; retry after the current placement completes");
  return result.value;
}
