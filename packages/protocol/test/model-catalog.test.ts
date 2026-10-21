import { expect, it } from "vitest";
import {
  parseModelCatalogConfiguration,
  parseModelRuntimeSnapshot,
  assertModelAdapter,
} from "../src/model-catalog.ts";
import {
  fixtureModelCatalog,
  fixtureModelRuntime,
} from "../../../scripts/lib/test-model-catalog.mjs";

it("admits a new model name under an existing adapter and validates complete capabilities", () => {
  const config = structuredClone(fixtureModelCatalog);
  config.models[1]!.modelId = "future-model";
  config.defaultModel.modelId = "future-model";
  expect(parseModelCatalogConfiguration(config).defaultModel.modelId).toBe("future-model");
  for (const mutate of [
    (v: typeof config) => {
      v.models[1]!.api = "openai-responses";
    },
    (v: typeof config) => {
      v.models[1]!.autoCompactTokenLimit = v.models[1]!.contextWindow;
    },
    (v: typeof config) => {
      v.models[1]!.defaultThinkingLevel = "off";
    },
    (v: typeof config) => {
      v.models[1]!.visible = false;
    },
    (v: typeof config) => {
      v.models.push(v.models[1]!);
    },
  ]) {
    const invalid = structuredClone(config);
    mutate(invalid);
    expect(() => parseModelCatalogConfiguration(invalid)).toThrow();
  }
  expect(() => parseModelCatalogConfiguration({ ...config, credentials: "unsupported" })).toThrow();
});
it("validates frozen snapshots independently of current model names", () => {
  const snapshot = fixtureModelRuntime("openai-codex", "gpt-6-luna")!;
  expect(parseModelRuntimeSnapshot(snapshot)).toEqual(snapshot);
  expect(() => assertModelAdapter("deepseek", snapshot)).toThrow();
  expect(() => parseModelRuntimeSnapshot({ ...snapshot, catalogRevision: "" })).toThrow();
});
