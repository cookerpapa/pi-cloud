import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);
const path = resolve(runtimeDirectory, "secrets/cli-proxy-management-key");
const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
try {
  const metadata = await handle.stat();
  if (
    !metadata.isFile() ||
    (metadata.mode & 0o077) !== 0 ||
    metadata.size < 1 ||
    metadata.size > 512
  ) {
    throw new Error("Provider Gateway management key is not a private bounded file");
  }
  const key = (await handle.readFile("utf8")).trim();
  if (!/^[A-Za-z0-9_-]{64}$/.test(key)) {
    throw new Error("Provider Gateway management key is invalid");
  }
  process.stdout.write(`${key}\n`);
} finally {
  await handle.close();
}
