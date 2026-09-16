import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, chown, lstat, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isMap, isSeq, parseDocument } from "yaml";
import { REVIEWED_MODELS } from "../packages/protocol/src/model-catalog.ts";

const deepSeekModels = new Map(
  REVIEWED_MODELS.filter((model) => model.provider === "deepseek").map((model) => [
    model.modelId,
    model,
  ]),
);

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
      (model) => isMap(model) && deepSeekModels.has(String(model.get("name") ?? "")),
    );
    if (!hasDeepSeekV4) continue;
    matched += 1;
    let providerChanged = false;
    if (
      String(provider.get("wire-api") ?? "")
        .trim()
        .toLowerCase() !== "responses"
    ) {
      provider.set("wire-api", "responses");
      providerChanged = true;
    }
    // CLIProxyAPI's generic compatibility default lacks none/max and silently
    // maps disabled thinking to low. Declare the reviewed native capabilities.
    for (const model of models.items) {
      if (!isMap(model)) continue;
      const reviewed = deepSeekModels.get(String(model.get("name") ?? ""));
      if (!reviewed) continue;
      const desired = {
        "zero-allowed": true,
        levels: reviewed.thinkingLevels.map((level) => (level === "off" ? "none" : level)),
      };
      const thinking = model.get("thinking", true);
      if (thinking === undefined) {
        model.set("thinking", desired);
        providerChanged = true;
      } else {
        if (!isMap(thinking)) throw new Error("DeepSeek thinking configuration must be a mapping");
        const current = thinking.toJSON();
        for (const [key, value] of Object.entries(desired)) {
          if (JSON.stringify(current[key]) === JSON.stringify(value)) continue;
          thinking.set(key, value);
          providerChanged = true;
        }
      }
    }
    if (providerChanged) changed += 1;
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
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

process.stdout.write(`${JSON.stringify({ matched, changed, wireApi: "responses" })}\n`);
