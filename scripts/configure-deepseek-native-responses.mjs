import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, lstat, open, readFile, rename } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMap, isSeq, parseDocument } from "yaml";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const runtimeDirectory = resolve(
  repositoryRoot,
  process.env.PI_CLOUD_RUNTIME_DIRECTORY ?? "deploy/production/runtime",
);
const configPath = resolve(runtimeDirectory, "secrets/cli-proxy-config.yaml");
const metadata = await lstat(configPath);
if (!metadata.isFile() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
  throw new Error("CLIProxyAPI configuration must be a private regular file");
}

const document = parseDocument(await readFile(configPath, "utf8"));
if (document.errors.length > 0) {
  throw new Error(`CLIProxyAPI configuration is invalid: ${document.errors[0]?.message}`);
}
const providers = document.get("openai-compatibility", true);
let matched = 0;
let changed = 0;
if (isSeq(providers)) {
  for (const provider of providers.items) {
    if (!isMap(provider)) continue;
    const models = provider.get("models", true);
    if (!isSeq(models)) continue;
    const hasDeepSeekV4 = models.items.some(
      (model) =>
        isMap(model) &&
        ["deepseek-v4-flash", "deepseek-v4-pro"].includes(String(model.get("name") ?? "")),
    );
    if (!hasDeepSeekV4) continue;
    matched += 1;
    if (
      String(provider.get("wire-api") ?? "")
        .trim()
        .toLowerCase() === "responses"
    )
      continue;
    provider.set("wire-api", "responses");
    changed += 1;
  }
}

if (changed > 0) {
  const temporaryPath = `${configPath}.${randomUUID()}.tmp`;
  const handle = await open(
    temporaryPath,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600,
  );
  try {
    await handle.writeFile(document.toString(), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporaryPath, 0o600);
  await chown(temporaryPath, metadata.uid, metadata.gid);
  await rename(temporaryPath, configPath);
  const directory = await open(dirname(configPath), constants.O_RDONLY);
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

process.stdout.write(`${JSON.stringify({ matched, changed, wireApi: "responses" })}\n`);
