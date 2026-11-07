import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { readPrivateRuntimeFile } from "./runtime-file-policy.mjs";

/** A dedicated receipt credential; never rotate existing provider credentials. */
export async function ensureMeteringSecret(runtimeDirectory) {
  const path = resolve(runtimeDirectory, "secrets/metering-ingest-token");
  try {
    const value = (await readPrivateRuntimeFile(path, 256, "Metering credential")).trim();
    if (!/^[A-Za-z0-9_-]{64}$/.test(value)) throw new Error("Invalid metering credential");
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const owner = await stat(resolve(runtimeDirectory, "secrets/cli-proxy-api-key"));
  const file = await open(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.chown(owner.uid, owner.gid);
    await file.writeFile(`${randomBytes(48).toString("base64url")}\n`);
    await file.sync();
  } finally {
    await file.close();
  }
}
