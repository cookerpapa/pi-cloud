import { constants } from "node:fs";
import { open, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname } from "node:path";

// Cube's POSIX plugin and guest use UID 1000. The host operator's private
// group grants that trusted reader access to its own three mounted Secrets.
export const VOLUME_READER_UID = 1000;
export const VOLUME_READER_SECRETS = new Set([
  "database-url",
  "workspace-volume-gateway-token",
  "metrics-token",
]);
export const runtimeSecretMode = (path) =>
  VOLUME_READER_SECRETS.has(basename(path)) ? 0o640 : 0o600;

export function unsafeRuntimeFileMode(metadata, path) {
  const groupRead = VOLUME_READER_SECRETS.has(basename(path));
  return (
    (metadata.mode & (groupRead ? 0o137 : 0o177)) !== 0 ||
    (groupRead &&
      (metadata.mode & 0o040) !== 0 &&
      process.geteuid?.() !== 0 &&
      ![process.getegid?.(), ...(process.getgroups?.() ?? [])].includes(metadata.gid))
  );
}

export async function readPrivateRuntimeFile(path, maximumBytes, label) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      unsafeRuntimeFileMode(metadata, path) ||
      metadata.size < 1 ||
      metadata.size > maximumBytes
    ) {
      throw new Error(`${label} is not a private bounded regular file`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/** Flush the prepared file and its rename before an operator issues effects. */
export async function writeRuntimeFileAtomically(path, body, mode = 0o600) {
  const temporary = `${path}.new-${randomUUID()}`;
  const file = await open(temporary, "wx", mode);
  try {
    try {
      await file.writeFile(body);
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
    const directory = await open(dirname(path), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
