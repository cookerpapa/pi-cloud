import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const usernamePosition = process.argv.indexOf("--username");
const username = process.argv[usernamePosition + 1]?.trim().toLowerCase();
if (
  process.argv.length !== 4 ||
  usernamePosition !== 2 ||
  username === undefined ||
  !/^[a-z0-9][a-z0-9._-]{2,47}$/u.test(username)
) {
  throw new Error("Usage: npm run production:administrator -- --username <registered-username>");
}

const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);
const environmentPath = resolve(runtimeDirectory, ".env");
const metadata = await lstat(environmentPath);
const currentUid = process.getuid?.();
if (
  !metadata.isFile() ||
  metadata.isSymbolicLink() ||
  (metadata.mode & 0o077) !== 0 ||
  currentUid === undefined ||
  metadata.uid !== currentUid ||
  metadata.size < 1 ||
  metadata.size > 64 * 1_024
) {
  throw new Error("Production environment must be a bounded private regular file");
}

const output = execFileSync(
  process.execPath,
  [
    "scripts/production-compose.mjs",
    "run",
    "--rm",
    "--no-deps",
    "database-bootstrap",
    "/app/packages/control-plane/src/platform-administrator.ts",
    "resolve",
    "--username",
    username,
  ],
  { cwd: repositoryRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);
const lines = output.split(/\r?\n/u).filter((line) => line.trim().startsWith("{"));
const account = JSON.parse(lines.at(-1) ?? "null");
if (
  typeof account !== "object" ||
  account === null ||
  account.username !== username ||
  typeof account.tenantId !== "string" ||
  !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(account.tenantId)
) {
  throw new Error("Platform administrator lookup returned an invalid identity");
}

let handle;
const temporaryPath = `${environmentPath}.tmp-${process.pid}`;
try {
  handle = await open(environmentPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  const openedMetadata = await handle.stat();
  if (openedMetadata.dev !== metadata.dev || openedMetadata.ino !== metadata.ino) {
    throw new Error("Production environment changed while it was being opened");
  }
  const contents = await handle.readFile("utf8");
  await handle.close();
  handle = undefined;
  const line = `PI_CLOUD_PLATFORM_OPERATOR_TENANT_ID=${account.tenantId}`;
  const next = /^PI_CLOUD_PLATFORM_OPERATOR_TENANT_ID=.*$/mu.test(contents)
    ? contents.replace(/^PI_CLOUD_PLATFORM_OPERATOR_TENANT_ID=.*$/mu, line)
    : `${contents.replace(/\n?$/u, "\n")}${line}\n`;
  const outputHandle = await open(temporaryPath, "wx", metadata.mode & 0o777);
  await outputHandle.writeFile(next, "utf8");
  await outputHandle.sync();
  await outputHandle.close();
  await rename(temporaryPath, environmentPath);
} finally {
  await handle?.close().catch(() => undefined);
  await rm(temporaryPath, { force: true }).catch(() => undefined);
}

execFileSync(
  process.execPath,
  [
    "scripts/production-compose.mjs",
    "up",
    "--detach",
    "--no-deps",
    "--force-recreate",
    "--wait",
    "control-plane",
  ],
  { cwd: repositoryRoot, stdio: "inherit" },
);
process.stdout.write(
  `Platform administrator configured for ${username}. Sign out and sign in again to refresh the browser identity.\n`,
);
