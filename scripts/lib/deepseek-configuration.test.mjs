import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { expect, it } from "vitest";

it("declares native DeepSeek reasoning including off/max without changing credentials or other models", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-cloud-deepseek-config-"));
  const path = join(directory, "secrets/cli-proxy-config.yaml");
  try {
    await mkdir(join(directory, "secrets"));
    const original = {
      "config-version": 8,
      access: { "api-keys": ["fixture-client-key"] },
      "api-keys": {
        "openai-compatibility": [
          {
            name: "deepseek",
            "wire-api": "responses",
            keys: [{ "api-key": "fixture-provider-key" }],
            models: [
              { name: "deepseek-v4-pro", alias: "deepseek-v4-pro" },
              { name: "other-model" },
            ],
          },
        ],
      },
    };
    await writeFile(path, stringify(original), { mode: 0o600 });
    const run = () =>
      promisify(execFile)(process.execPath, ["scripts/configure-deepseek-native-responses.mjs"], {
        env: { ...process.env, PI_CLOUD_RUNTIME_DIRECTORY: directory },
      });
    await run();
    const configured = parse(await readFile(path, "utf8"));
    const provider = configured["api-keys"]["openai-compatibility"][0];
    expect(provider.models[0].thinking).toEqual({
      "zero-allowed": true,
      levels: ["none", "low", "medium", "high", "max"],
    });
    expect(provider.models[1]).toEqual(original["api-keys"]["openai-compatibility"][0].models[1]);
    expect(provider.keys).toEqual(original["api-keys"]["openai-compatibility"][0].keys);
    expect(configured.access).toEqual(original.access);
    const bytes = await readFile(path, "utf8");
    expect(JSON.parse((await run()).stdout).changed).toBe(0);
    expect(await readFile(path, "utf8")).toBe(bytes);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
