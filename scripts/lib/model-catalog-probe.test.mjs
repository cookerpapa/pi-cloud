import { expect, it, vi } from "vitest";
import { changedVisibleModels, probeCatalogModel } from "./model-catalog-probe.mjs";

const model = {
  provider: "openai-codex",
  modelId: "future",
  visible: true,
  maxTokens: 32768,
  thinkingLevels: ["low"],
  displayName: "future",
};
it("probes new/changed visible capabilities while ignoring labels and defaults", () => {
  expect(changedVisibleModels({ models: [] }, { models: [model] })).toEqual([model]);
  expect(
    changedVisibleModels({ models: [model] }, { models: [{ ...model, displayName: "new label" }] }),
  ).toEqual([]);
  expect(
    changedVisibleModels({ models: [model] }, { models: [{ ...model, maxTokens: 16384 }] }),
  ).toHaveLength(1);
  expect(
    changedVisibleModels({ models: [model] }, { models: [{ ...model, visible: false }] }),
  ).toEqual([]);
});
it("requires genuine function and text responses with the requested model identity", async () => {
  const first = {
    model: "future",
    status: "completed",
    output: [{ type: "function_call", name: "catalog_probe", arguments: "{}", call_id: "fixture" }],
  };
  const second = {
    model: "future",
    status: "completed",
    output: [{ content: [{ type: "output_text", text: "CATALOG_ROUTE_OK" }] }],
  };
  const fetchImplementation = vi
    .fn()
    .mockResolvedValueOnce(Response.json(first))
    .mockResolvedValueOnce(Response.json(second));
  await expect(
    probeCatalogModel({
      model,
      baseUrl: "http://fixture",
      apiKey: "fixture-key",
      fetchImplementation,
    }),
  ).resolves.toMatchObject({ modelId: "future", text: true, functionCalling: true });
  const substituted = vi.fn().mockResolvedValue(Response.json({ ...first, model: "other" }));
  await expect(
    probeCatalogModel({
      model,
      baseUrl: "http://fixture",
      apiKey: "fixture-key",
      fetchImplementation: substituted,
    }),
  ).rejects.toThrow("different model");
  expect(substituted).toHaveBeenCalledOnce();
});
