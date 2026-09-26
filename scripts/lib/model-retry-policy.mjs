import { parseDocument } from "yaml";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { chown, lstat, open, rename, unlink } from "node:fs/promises";
import { readPrivateRuntimeFile } from "./runtime-file-policy.mjs";

/** Only the deployment-owned root retry policy; leave credential routing intact. */
export function applyModelRetryPolicy(source) {
  const document = parseDocument(source);
  if (document.errors.length || !document.contents || !document.has("port"))
    throw new Error("Provider Gateway configuration is invalid");
  if (document.get("request-retry") === 0) return source;
  document.set("request-retry", 0);
  return document.toString();
}

export async function updateModelRetryPolicyFile(path) {
  const source = await readPrivateRuntimeFile(path, 64 * 1024, "Provider Gateway configuration");
  const changed = applyModelRetryPolicy(source);
  if (source === changed) return false;
  const original = await lstat(path);
  const temporary = `${path}.update-${randomUUID()}`;
  try {
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(changed);
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (process.geteuid?.() === 0) await chown(temporary, original.uid, original.gid);
    await rename(temporary, path);
    const parent = await open(dirname(path), "r");
    try {
      await parent.sync();
    } finally {
      await parent.close();
    }
  } finally {
    await unlink(temporary).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  return true;
}
