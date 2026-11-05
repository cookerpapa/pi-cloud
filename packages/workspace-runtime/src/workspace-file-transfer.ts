import { constants } from "node:fs";
import {
  open,
  mkdir,
  link,
  rename,
  unlink,
  rmdir,
  lstat,
  opendir,
  type FileHandle,
} from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import {
  parseWorkspaceFileTransferRequest,
  WORKSPACE_TRANSFER_TTL_MS,
  type WorkspaceFileTransferRequest,
  type WorkspaceFileTransferSnapshot,
} from "@pi-cloud/protocol/transfers";
import { acquireFileLock } from "./file-lock.ts";

const DIR = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const READ = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const at = (fd: FileHandle, name: string) => `/proc/self/fd/${fd.fd}/${name}`;
const transferName = /^transfer-[0-9a-f-]{36}$/;
type Metadata = {
  identity: string;
  root: string;
  parent: string;
  expiresAt: number;
  state: "uploading" | "publishing" | "ready" | "cancelled" | "failed";
  inode?: string;
};

export class WorkspaceFileTransferError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "WorkspaceFileTransferError";
  }
}
const fail = (code: string, message: string): never => {
  throw new WorkspaceFileTransferError(code, message);
};
async function inode(file: FileHandle) {
  const stat = await file.stat({ bigint: true });
  return `${stat.dev}:${stat.ino}`;
}
function identity(input: WorkspaceFileTransferRequest) {
  return JSON.stringify([
    input.uploadId,
    input.claimToken,
    input.tenantId,
    input.sessionId,
    input.workspaceId,
    input.rootPath,
    input.machine?.environmentId,
    input.machine?.directory,
    input.name,
    input.relativePath,
    input.byteLength,
    input.sha256,
    input.createParents,
  ]);
}
async function readMetadata(directory: FileHandle): Promise<Metadata | undefined> {
  const file = await open(at(directory, "metadata"), READ).catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (!file) return;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > 32 * 1024)
      fail("transfer_identity", "Transfer metadata is invalid");
    const value = JSON.parse(await file.readFile("utf8")) as Metadata;
    if (
      typeof value.identity !== "string" ||
      typeof value.root !== "string" ||
      typeof value.parent !== "string" ||
      !Number.isFinite(value.expiresAt) ||
      !["uploading", "publishing", "ready", "cancelled", "failed"].includes(value.state)
    )
      fail("transfer_identity", "Transfer metadata is invalid");
    return value;
  } finally {
    await file.close();
  }
}
async function writeMetadata(directory: FileHandle, value: Metadata) {
  const path = at(directory, `.part-${randomUUID()}`);
  const file = await open(
    path,
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
    await rename(path, at(directory, "metadata"));
    await directory.sync();
  } finally {
    await unlink(path).catch(() => undefined);
  }
}
async function destination(
  root: FileHandle,
  input: WorkspaceFileTransferRequest,
): Promise<FileHandle> {
  let current = await open(`/proc/self/fd/${root.fd}`, constants.O_RDONLY | constants.O_DIRECTORY);
  try {
    for (const part of input.relativePath.split("/").slice(0, -1)) {
      if (input.createParents) {
        await mkdir(at(current, part), { mode: 0o700 }).catch((error) => {
          if (error.code !== "EEXIST") throw error;
        });
        await current.sync();
      }
      const next = await open(at(current, part), DIR);
      await current.close();
      current = next;
    }
    return current;
  } catch (error) {
    await current.close();
    throw error;
  }
}
async function digest(file: FileHandle, length: number, signal?: AbortSignal) {
  const hash = createHash("sha256"),
    buffer = Buffer.allocUnsafe(256 * 1024);
  let position = 0;
  while (true) {
    signal?.throwIfAborted();
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    if (!bytesRead) break;
    position += bytesRead;
    if (position > length) fail("transfer_content", "Workspace file length changed");
    hash.update(buffer.subarray(0, bytesRead));
  }
  if (position !== length) fail("transfer_content", "Workspace file is incomplete");
  return hash.digest("hex");
}

/** Caller owns the root and shared staging-area lifetime. All requests, including
 * separate Guest processes, serialize against the same OS-held transfer lock. */
export async function workspaceFileTransfer(
  root: FileHandle,
  staging: FileHandle,
  value: WorkspaceFileTransferRequest,
  chunks?: AsyncIterable<Uint8Array>,
  signal?: AbortSignal,
): Promise<WorkspaceFileTransferSnapshot> {
  const input = parseWorkspaceFileTransferRequest(value);
  signal?.throwIfAborted();
  const path = at(staging, `transfer-${input.uploadId}`);
  if (input.action === "create" || input.action === "cancel") {
    await mkdir(path, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    await staging.sync();
  }
  const directory = await open(path, DIR).catch((error) => {
    if (error.code === "ENOENT") fail("transfer_missing", "Workspace upload is missing or expired");
    throw error;
  });
  let lock: FileHandle | undefined, parent: FileHandle | undefined, file: FileHandle | undefined;
  try {
    lock = await open(
      at(directory, "lock"),
      constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      0o600,
    );
    if (!(await lock.stat()).isFile() || !(await acquireFileLock(lock.fd, false, 30_000)))
      fail("transfer_busy", "Workspace upload is busy");
    const named = await lstat(path, { bigint: true });
    if (!named.isDirectory() || `${named.dev}:${named.ino}` !== (await inode(directory)))
      fail("transfer_identity", "Workspace upload directory changed");
    let meta = await readMetadata(directory);
    if (meta && meta.identity !== identity(input))
      fail("transfer_identity", "Workspace upload identity changed");
    if (input.action === "cancel") {
      if (meta?.state === "ready")
        return { state: "ready", offset: input.byteLength, relativePath: input.relativePath };
      // Retain a tombstone: an already-admitted, delayed create cannot resurrect it.
      meta = {
        identity: identity(input),
        root: meta?.root ?? "",
        parent: meta?.parent ?? "",
        expiresAt: Math.max(meta?.expiresAt ?? 0, Date.now() + WORKSPACE_TRANSFER_TTL_MS),
        state: "cancelled",
      };
      await writeMetadata(directory, meta);
      await unlink(at(directory, "body")).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      await directory.sync();
      return { state: "cancelled", offset: 0, relativePath: input.relativePath };
    }
    if (meta?.state === "cancelled") fail("transfer_cancelled", "Workspace upload was cancelled");
    if (meta?.state === "failed")
      fail("transfer_content", "Workspace upload failed verification; select the source again");
    if (meta && meta.expiresAt <= Date.now()) fail("transfer_expired", "Workspace upload expired");
    if (Date.parse(input.expiresAt) <= Date.now())
      fail("transfer_expired", "Workspace upload authorization expired");
    if (meta?.state === "ready")
      return { state: "ready", offset: input.byteLength, relativePath: input.relativePath };
    parent = await destination(root, input);
    if ((await parent.stat()).dev !== (await staging.stat()).dev)
      fail("transfer_path", "Upload must remain on its Workspace filesystem");
    const rootIdentity = await inode(root),
      parentIdentity = await inode(parent);
    if (!meta) {
      if (input.action !== "create")
        fail("transfer_missing", "Workspace upload has not been created");
      meta = {
        identity: identity(input),
        root: rootIdentity,
        parent: parentIdentity,
        expiresAt: Date.parse(input.expiresAt),
        state: "uploading",
      };
      await writeMetadata(directory, meta);
    }
    if (meta.root !== rootIdentity || meta.parent !== parentIdentity)
      fail("transfer_path", "Upload destination directory changed");
    meta.expiresAt = Math.max(meta.expiresAt, Date.parse(input.expiresAt));
    await writeMetadata(directory, meta);
    file = await open(
      at(directory, "body"),
      constants.O_RDWR |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        (input.action === "create" ? constants.O_CREAT : 0),
      0o600,
    );
    let stat = await file.stat();
    if (!stat.isFile() || stat.size > input.byteLength)
      fail("transfer_content", "Workspace upload content changed");
    if (input.action === "append") {
      if (meta.state !== "uploading" || input.offset !== stat.size)
        fail("transfer_offset", "Upload offset changed; query its current position");
      if (!chunks) fail("transfer_content", "Missing upload chunk");
      let received = 0;
      try {
        for await (const chunk of chunks!) {
          signal?.throwIfAborted();
          if (received + chunk.byteLength > input.chunkLength!)
            fail("transfer_content", "Upload chunk exceeds its declared length");
          let written = 0;
          while (written < chunk.byteLength) {
            const result = await file.write(
              chunk,
              written,
              chunk.byteLength - written,
              stat.size + received + written,
            );
            if (!result.bytesWritten) throw new Error("Workspace write made no progress");
            written += result.bytesWritten;
          }
          received += chunk.byteLength;
        }
      } finally {
        await file.sync();
      }
      if (received !== input.chunkLength) fail("transfer_content", "Upload chunk was interrupted");
      stat = await file.stat();
    }
    await file.sync();
    await directory.sync();
    if (stat.size !== input.byteLength)
      return { state: "uploading", offset: stat.size, relativePath: input.relativePath };
    const target = at(parent, input.name);
    if (meta.state === "publishing") {
      const existing = await open(target, READ).catch(() => undefined);
      try {
        if (!existing || (await inode(existing)) !== meta.inode)
          fail(
            "transfer_uncertain",
            "Upload publication was interrupted; inspect the destination before uploading again",
          );
      } finally {
        await existing?.close();
      }
    } else {
      if ((await digest(file, input.byteLength, signal)) !== input.sha256) {
        meta.state = "failed";
        await writeMetadata(directory, meta);
        fail("transfer_content", "Workspace file checksum does not match the selected source");
      }
      signal?.throwIfAborted();
      meta.state = "publishing";
      meta.inode = await inode(file);
      await writeMetadata(directory, meta);
      try {
        await link(at(directory, "body"), target);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          meta.state = "failed";
          await writeMetadata(directory, meta);
          fail("transfer_conflict", "A file already exists at the destination");
        }
        throw error;
      }
    }
    await parent.sync();
    meta.state = "ready";
    await writeMetadata(directory, meta);
    await unlink(at(directory, "body"));
    await directory.sync();
    return { state: "ready", offset: input.byteLength, relativePath: input.relativePath };
  } finally {
    await file?.close();
    await parent?.close();
    await lock?.close();
    await directory.close();
  }
}

/** Called only under the existing area's exclusive maintenance lock. */
export async function reapWorkspaceFileTransfer(
  staging: FileHandle,
  name: string,
  now = Date.now(),
) {
  if (!transferName.test(name)) return { files: 0, bytes: 0 };
  const directory = await open(at(staging, name), DIR);
  let bytes = 0;
  try {
    const meta = await readMetadata(directory);
    const expires = meta?.expiresAt ?? (await directory.stat()).mtimeMs + WORKSPACE_TRANSFER_TTL_MS;
    if (expires > now) return { files: 0, bytes: 0 };
    const entries = await opendir(`/proc/self/fd/${directory.fd}`);
    for await (const entry of entries) {
      if (
        !["metadata", "lock", "body"].includes(entry.name) &&
        !/^\.part-[0-9a-f-]{36}$/.test(entry.name)
      )
        fail("transfer_identity", "Unexpected upload staging content");
      const stat = await lstat(at(directory, entry.name));
      if (!stat.isFile()) fail("transfer_identity", "Unexpected upload staging entry");
      if (entry.name === "body") bytes += stat.size;
      await unlink(at(directory, entry.name));
    }
    await directory.sync();
  } finally {
    await directory.close();
  }
  await rmdir(at(staging, name));
  await staging.sync();
  return { files: 1, bytes };
}
