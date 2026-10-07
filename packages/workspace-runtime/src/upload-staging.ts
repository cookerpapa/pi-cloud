import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, link, unlink, type FileHandle } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { acquireFileLock } from "./file-lock.ts";

const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const MARKER = "pi-cloud-upload-staging-v1\n";
export const UPLOAD_STAGING_NAME = ".pi-cloud-upload-staging-v1";
const partial = /^\.part-[0-9a-f-]{36}$/;
const at = (directory: FileHandle, name: string) => `/proc/self/fd/${directory.fd}/${name}`;

async function marker(directory: FileHandle): Promise<string | undefined> {
  let file: FileHandle;
  try {
    file = await open(
      at(directory, "identity"),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 128) throw new Error("Invalid upload staging identity");
    return await file.readFile("utf8");
  } finally {
    await file.close();
  }
}

/** Managed temporary bytes only. The enclosing adapter owns path authorization
 * and discovery; this class supplies cross-process exclusion and safe reaping. */
export class UploadStagingArea {
  constructor(
    readonly directory: string,
    readonly expected?: { dev: string; ino: string },
  ) {
    if (!isAbsolute(directory) || directory.includes("\0"))
      throw new Error("Invalid staging directory");
  }

  async prepare(): Promise<void> {
    await mkdir(this.directory, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    const parent = await open(dirname(this.directory), DIRECTORY);
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
    const existing = await open(this.directory, DIRECTORY);
    try {
      const identity = await marker(existing);
      if (identity === MARKER) return; // use()/exclusive() still validate under their lock.
      if (identity !== undefined) throw new Error("Invalid upload staging identity");
    } finally {
      await existing.close();
    }
    // Initialization is short and exclusive. No shared lock is upgraded.
    await this.#locked(false, 30_000, true, async (directory) => {
      const identity = await marker(directory);
      if (identity !== undefined && identity !== MARKER)
        throw new Error("Invalid upload staging identity");
      if (identity === undefined) {
        const contents = await opendir(`/proc/self/fd/${directory.fd}`);
        for await (const entry of contents) {
          if (!["lock", "files"].includes(entry.name) && !partial.test(entry.name))
            throw new Error("Unrecognized upload staging directory");
          if (partial.test(entry.name)) await unlink(at(directory, entry.name));
        }
        await mkdir(at(directory, "files"), { mode: 0o700 }).catch((error) => {
          if (error.code !== "EEXIST") throw error;
        });
        const files = await open(at(directory, "files"), DIRECTORY);
        try {
          const entries = await opendir(`/proc/self/fd/${files.fd}`);
          for await (const _entry of entries) throw new Error("Unrecognized upload staging bytes");
        } finally {
          await files.close();
        }
        const path = at(directory, `.part-${randomUUID()}`);
        const file = await open(
          path,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
          0o600,
        );
        try {
          await file.writeFile(MARKER);
          await file.sync();
        } finally {
          await file.close();
        }
        try {
          await link(path, at(directory, "identity"));
        } finally {
          await unlink(path);
        }
      }
      await directory.sync();
    });
  }

  async use<T>(run: (directory: FileHandle) => Promise<T>): Promise<T> {
    const result = await this.#files(true, 30_000, run);
    if (!result) throw new Error("Upload staging is busy or unavailable");
    return result.value;
  }

  /** Metadata registration/maintenance also uses the same OS-held lifetime. */
  exclusive<T>(run: (directory: FileHandle) => Promise<T>, waitMs = 0) {
    return this.#files(false, waitMs, run);
  }

  async reap(maximum = 64): Promise<{ busy: boolean; files: number; bytes: number }> {
    const result = await this.exclusive(async (directory) => {
      let files = 0,
        bytes = 0,
        inspected = 0;
      const entries = await opendir(`/proc/self/fd/${directory.fd}`);
      for await (const entry of entries) {
        if (partial.test(entry.name)) {
          const stat = await lstat(at(directory, entry.name));
          if (!stat.isFile()) throw new Error("Invalid upload staging file");
          await unlink(at(directory, entry.name));
          files++;
          bytes += stat.size;
        }
        if (++inspected >= maximum) break;
      }
      if (files) await directory.sync();
      return { files, bytes };
    });
    return { busy: !result, files: result?.value.files ?? 0, bytes: result?.value.bytes ?? 0 };
  }

  async #files<T>(shared: boolean, waitMs: number, run: (directory: FileHandle) => Promise<T>) {
    return this.#locked(shared, waitMs, false, async (directory) => {
      if ((await marker(directory)) !== MARKER) throw new Error("Invalid upload staging identity");
      const files = await open(at(directory, "files"), DIRECTORY);
      try {
        return await run(files);
      } finally {
        await files.close();
      }
    });
  }

  async #locked<T>(
    shared: boolean,
    waitMs: number,
    create: boolean,
    run: (directory: FileHandle) => Promise<T>,
  ): Promise<{ value: T } | undefined> {
    let directory: FileHandle;
    try {
      directory = await open(this.directory, DIRECTORY);
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    let lock: FileHandle | undefined;
    try {
      const original = await directory.stat({ bigint: true });
      if (
        this.expected &&
        (original.dev.toString() !== this.expected.dev ||
          original.ino.toString() !== this.expected.ino)
      )
        throw new Error("Upload staging locator changed");
      lock = await open(
        at(directory, "lock"),
        constants.O_RDWR |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          (create ? constants.O_CREAT : 0),
        0o600,
      );
      const held = await lock.stat({ bigint: true });
      if (!held.isFile() || held.size !== 0n) throw new Error("Invalid upload staging lock");
      if (!(await acquireFileLock(lock.fd, shared, waitMs))) return;
      const [current, named] = await Promise.all([
        lstat(this.directory, { bigint: true }),
        lstat(join(this.directory, "lock"), { bigint: true }),
      ]);
      if (
        !current.isDirectory() ||
        current.dev !== original.dev ||
        current.ino !== original.ino ||
        !named.isFile() ||
        named.dev !== held.dev ||
        named.ino !== held.ino
      )
        throw new Error("Upload staging identity changed");
      return { value: await run(directory) };
    } finally {
      await lock?.close();
      await directory.close();
    }
  }
}
