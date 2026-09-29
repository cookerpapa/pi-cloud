import { constants } from "node:fs";
import { open, mkdir, link, unlink, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import {
  MAX_USER_UPLOAD_BYTES,
  uploadFileName,
  uploadRelativePath,
} from "@pi-cloud/protocol/uploads";

/** Linux fd-relative placement. Caller owns and has authorized the root fd.
 * Exclusive link publishes a complete file without replacing user changes. */
export async function writeWorkspaceUpload(
  root: FileHandle,
  input: {
    id: string;
    name: string;
    bytes: Uint8Array;
    sha256: string;
    signal?: AbortSignal;
  },
): Promise<{ relativePath: string; byteLength: number; sha256: string }> {
  const relativePath = uploadRelativePath(input.id, input.name);
  if (
    !input.bytes.length ||
    input.bytes.length > MAX_USER_UPLOAD_BYTES ||
    createHash("sha256").update(input.bytes).digest("hex") !== input.sha256
  )
    throw new Error("Upload content does not match its identity or size limit");
  input.signal?.throwIfAborted();
  const directories: FileHandle[] = [];
  let current = root;
  let temporary: string | undefined;
  try {
    for (const part of ["uploads", input.id]) {
      const path = `/proc/self/fd/${current.fd}/${part}`;
      await mkdir(path, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
      const directory = await open(
        path,
        constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
      );
      directories.push(directory);
      await current.sync();
      current = directory;
    }
    const parent = `/proc/self/fd/${current.fd}`;
    temporary = `${parent}/.upload-${randomUUID()}`;
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await file.writeFile(input.bytes, { signal: input.signal });
      await file.sync();
    } finally {
      await file.close();
    }
    input.signal?.throwIfAborted();
    const target = `${parent}/${uploadFileName(input.name)}`;
    try {
      await link(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await existing.stat();
        if (!stat.isFile() || stat.size !== input.bytes.length)
          throw new Error("Upload destination already contains different content");
        const digest = createHash("sha256");
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let total = 0;
        while (true) {
          const { bytesRead } = await existing.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          total += bytesRead;
          if (total > input.bytes.length)
            throw new Error("Upload destination changed during verification");
          digest.update(buffer.subarray(0, bytesRead));
        }
        if (total !== input.bytes.length || digest.digest("hex") !== input.sha256)
          throw new Error("Upload destination already contains different content");
      } finally {
        await existing.close();
      }
    }
    await current.sync();
    return { relativePath, byteLength: input.bytes.length, sha256: input.sha256 };
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
    for (const directory of directories.reverse()) await directory.close();
  }
}
