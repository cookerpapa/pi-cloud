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

it("keeps DeepSeek thinking enabled and accepts only its reviewed Flash response identity", async () => {
  const fetchImplementation = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        model: "deepseek-flash",
        status: "completed",
        output: [{ type: "function_call", name: "catalog_probe", arguments: "{}", call_id: "id" }],
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        model: "deepseek-flash",
        status: "completed",
        output: [{ content: [{ type: "output_text", text: "CATALOG_ROUTE_OK" }] }],
      }),
    );
  await expect(
    probeCatalogModel({
      model: { ...model, provider: "deepseek", modelId: "deepseek-v4-flash" },
      baseUrl: "http://fixture",
      apiKey: "fixture-key",
      fetchImplementation,
    }),
  ).resolves.toMatchObject({
    text: true,
    functionCalling: true,
    responseModels: ["deepseek-flash", "deepseek-flash"],
  });
  const requests = fetchImplementation.mock.calls.map(([, init]) => JSON.parse(init.body));
  expect(requests.map((request) => request.tool_choice)).toEqual(["auto", "auto"]);
  expect(requests.map((request) => request.tools.length)).toEqual([1, 0]);
  expect(requests.every((request) => request.reasoning.effort === "low")).toBe(true);
  expect(requests[1].input.at(-1)).toMatchObject({
    type: "function_call_output",
    call_id: "id",
    output: "CATALOG_ROUTE_OK",
  });
  await expect(
    probeCatalogModel({
      model: { ...model, provider: "deepseek", modelId: "deepseek-v4-flash" },
      baseUrl: "http://fixture",
      apiKey: "fixture-key",
      fetchImplementation: vi
        .fn()
        .mockResolvedValue(
          Response.json({ model: "deepseek-v4-pro", status: "completed", output: [] }),
        ),
    }),
  ).rejects.toThrow("different model");
});
