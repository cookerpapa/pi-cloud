import { constants } from "node:fs";
import { lstat, open, opendir, rename, unlink, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { UploadStagingArea } from "./upload-staging.ts";

const at = (directory: FileHandle, name: string) => `/proc/self/fd/${directory.fd}/${name}`;
const locatorName = /^area-[0-9a-f]{64}\.json$/;
type Locator = { directory: string; dev: string; ino: string };

async function read(directory: FileHandle, name: string): Promise<unknown> {
  const file = await open(
    at(directory, name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 8192) throw new Error("Invalid upload staging locator");
    return JSON.parse(await file.readFile("utf8"));
  } finally {
    await file.close();
  }
}
async function write(directory: FileHandle, name: string, value: unknown) {
  const temporary = at(directory, `.part-${randomUUID()}`);
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, at(directory, name));
    await directory.sync();
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

/** Derived filesystem locators survive expiry/deletion of a PG upload claim.
 * Register before taking the upload's shared area lock or writing large bytes. */
export async function registerUploadStaging(registryDirectory: string, directory: string) {
  const registry = new UploadStagingArea(registryDirectory);
  await registry.prepare();
  const stat = await lstat(directory, { bigint: true });
  if (!stat.isDirectory()) throw new Error("Invalid upload staging directory");
  const locator: Locator = { directory, dev: stat.dev.toString(), ino: stat.ino.toString() };
  const name = `area-${createHash("sha256").update(directory).digest("hex")}.json`;
  if (
    !(await registry.exclusive(async (files) => {
      const previous = await read(files, name).catch((error) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (JSON.stringify(previous) !== JSON.stringify(locator)) await write(files, name, locator);
    }, 30_000))
  )
    throw new Error("Upload staging registry is busy");
  return locator;
}

export async function reapRegisteredUploads(registryDirectory: string, maximumAreas = 8) {
  const registry = new UploadStagingArea(registryDirectory);
  const result = await registry.exclusive(async (files) => {
    const saved = await read(files, "cursor").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    if (typeof saved !== "string" || (saved !== "" && !locatorName.test(saved)))
      throw new Error("Invalid upload staging cursor");
    let after = saved === "",
      last = "",
      areas = 0,
      removed = 0,
      bytes = 0,
      deferred = 0,
      busyAreas = 0,
      limited = false;
    const entries = await opendir(`/proc/self/fd/${files.fd}`);
    for await (const entry of entries) {
      if (/^\.part-[0-9a-f-]{36}$/.test(entry.name)) {
        await unlink(at(files, entry.name));
        continue;
      }
      if (!locatorName.test(entry.name)) continue;
      if (!after) {
        if (entry.name === saved) after = true;
        continue;
      }
      last = entry.name;
      try {
        const value = (await read(files, entry.name)) as Locator;
        if (
          !value ||
          typeof value.directory !== "string" ||
          typeof value.dev !== "string" ||
          typeof value.ino !== "string" ||
          entry.name !== `area-${createHash("sha256").update(value.directory).digest("hex")}.json`
        )
          throw new Error("Invalid upload staging locator");
        const reaped = await new UploadStagingArea(value.directory, value).reap();
        removed += reaped.files;
        bytes += reaped.bytes;
        if (reaped.busy) busyAreas++;
      } catch {
        deferred++;
      }
      if (++areas >= maximumAreas) {
        limited = true;
        break;
      }
    }
    await write(files, "cursor", limited ? last : "");
    return { areas, files: removed, bytes, deferred, busyAreas };
  });
  return result?.value ?? { areas: 0, files: 0, bytes: 0, deferred: 0, busyAreas: 0 };
}
