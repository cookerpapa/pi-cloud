import { constants } from "node:fs";
import { open, mkdir, link, unlink, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { uploadFileName, uploadRelativePath } from "@pi-cloud/protocol/uploads";

/** Linux fd-relative placement. Caller owns and has authorized the root fd.
 * Exclusive link publishes a complete file without replacing user changes. */
type FileInput = {
  id: string;
  name: string;
  chunks: AsyncIterable<Uint8Array>;
  byteLength: number;
  sha256: string;
  signal?: AbortSignal;
};
export async function writeWorkspaceUpload(
  root: FileHandle,
  input: FileInput,
  staging: FileHandle,
) {
  return writeAsset(
    root,
    input,
    staging,
    ["uploads", input.id],
    uploadRelativePath(input.id, input.name),
  );
}
export async function writeGeneratedImage(
  root: FileHandle,
  input: Omit<FileInput, "name">,
  staging: FileHandle,
) {
  // Reuse UUID/name validation and exclusive publication without giving callers
  // arbitrary directory creation or overwrite semantics.
  uploadRelativePath(input.id, "image.png");
  const name = `${input.id}.png`;
  return writeAsset(
    root,
    { ...input, name },
    staging,
    ["generated_images"],
    `generated_images/${name}`,
  );
}
async function writeAsset(
  root: FileHandle,
  input: FileInput,
  staging: FileHandle,
  pathParts: string[],
  relativePath: string,
): Promise<{ relativePath: string; byteLength: number; sha256: string }> {
  if (
    !Number.isSafeInteger(input.byteLength) ||
    input.byteLength < 1 ||
    !/^[0-9a-f]{64}$/.test(input.sha256)
  )
    throw new Error("Upload content identity is invalid");
  input.signal?.throwIfAborted();
  const directories: FileHandle[] = [];
  let current = root;
  let temporary: string | undefined;
  try {
    for (const part of pathParts) {
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
    if ((await staging.stat()).dev !== (await current.stat()).dev)
      throw new Error("Upload staging and destination must share one filesystem");
    temporary = `/proc/self/fd/${staging.fd}/.part-${randomUUID()}`;
    const file = await open(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      const hash = createHash("sha256");
      let length = 0;
      for await (const chunk of input.chunks) {
        input.signal?.throwIfAborted();
        length += chunk.byteLength;
        if (length > input.byteLength) throw new Error("Upload exceeds its declared length");
        hash.update(chunk);
        await file.writeFile(chunk, { signal: input.signal });
      }
      if (length !== input.byteLength || hash.digest("hex") !== input.sha256)
        throw new Error("Upload content does not match its declared identity");
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
        if (!stat.isFile() || stat.size !== input.byteLength)
          throw new Error("Upload destination already contains different content");
        const digest = createHash("sha256");
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let total = 0;
        while (true) {
          const { bytesRead } = await existing.read(buffer, 0, buffer.length, null);
          if (!bytesRead) break;
          total += bytesRead;
          if (total > input.byteLength)
            throw new Error("Upload destination changed during verification");
          digest.update(buffer.subarray(0, bytesRead));
        }
        if (total !== input.byteLength || digest.digest("hex") !== input.sha256)
          throw new Error("Upload destination already contains different content");
      } finally {
        await existing.close();
      }
    }
    await current.sync();
    return { relativePath, byteLength: input.byteLength, sha256: input.sha256 };
  } finally {
    if (temporary) await unlink(temporary).catch(() => {});
    for (const directory of directories.reverse()) await directory.close();
  }
}
