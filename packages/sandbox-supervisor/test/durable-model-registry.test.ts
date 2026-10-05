import { expect, it } from "vitest";
import { CloudModelRegistry } from "../src/durable/model-registry.ts";

it.each(["openai-completions", "openai-responses", "openai-codex-responses"] as const)(
  "requires a live request capability for %s without OAuth or ambient credentials",
  async (api) => {
    const registry = new CloudModelRegistry();
    const model = registry.configure({
      provider: "openai-codex",
      modelId: "gpt-6-luna",
      api,
      baseUrl: "http://private-gateway",
      apiKey: "not-a-stored-credential",
    });
    expect(await registry.models.getAuth(model)).toBeUndefined();
    expect(await registry.models.getAuth(model, { apiKey: "live-run-capability" })).toMatchObject({
      auth: { apiKey: "live-run-capability" },
    });
    expect(JSON.stringify(registry.models.getModels())).not.toContain("capability");
    expect(JSON.stringify(registry.models.getModels())).not.toContain("not-a-stored");
  },
);
