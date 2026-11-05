import { lstat, opendir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { WORKSPACE_TRANSFER_TTL_MS } from "@pi-cloud/protocol/transfers";

/** These random, never-reused names belong exclusively to the fixed input
 * transport. All source consumers have bounded preparation lifetimes; ordinary
 * Tool command envelopes/background processes are deliberately excluded. */
export async function reapUploadTransit(directory = "/tmp", now = Date.now()) {
  const entries = await opendir(directory);
  let files = 0,
    bytes = 0;
  for await (const entry of entries) {
    if (
      !/^pi-cloud-upload-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
        entry.name,
      ) ||
      !entry.isFile()
    )
      continue;
    const path = join(directory, entry.name);
    const stat = await lstat(path).catch((error) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (!stat?.isFile() || stat.mtimeMs + WORKSPACE_TRANSFER_TTL_MS > now) continue;
    await unlink(path).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
    files++;
    bytes += stat.size;
  }
  return { files, bytes };
}
