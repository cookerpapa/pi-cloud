import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export function changedVisibleModels(previous, next) {
  return next.models.filter((model) => {
    if (!model.visible) return false;
    const old = previous.models.find(
      (m) => m.provider === model.provider && m.modelId === model.modelId,
    );
    if (!old?.visible) return true;
    const runtime = ({ displayName: _name, visible: _visible, ...value }) => value;
    return JSON.stringify(runtime(old)) !== JSON.stringify(runtime(model));
  });
}

/** Two bounded fixture requests prove text/function routing, not every declared capability. */
export async function probeCatalogModel({ model, baseUrl, apiKey, fetchImplementation = fetch }) {
  const tool = {
    type: "function",
    name: "catalog_probe",
    description: "Return the fixture marker.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
    strict: true,
  };
  const prompt = {
    role: "user",
    content: "Call catalog_probe once, then answer only the exact marker it returns.",
  };
  const call = async (input, choice) => {
    const response = await fetchImplementation(`${baseUrl}/v1/responses`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${apiKey}`,
        "content-type": "application/json",
        "session-id": `catalog-${randomUUID()}`,
      },
      body: JSON.stringify({
        model: model.modelId,
        stream: false,
        store: false,
        instructions: "Follow the fixture exactly and be concise.",
        input,
        tools: [tool],
        tool_choice: choice,
        max_output_tokens: Math.min(model.maxTokens, 512),
        ...(model.thinkingLevels.includes("low") ? { reasoning: { effort: "low" } } : {}),
      }),
      signal: AbortSignal.timeout(120000),
    });
    assert.equal(response.status, 200, `Catalog model probe returned HTTP ${response.status}`);
    const result = await response.json();
    assert.equal(result.status, "completed", "Catalog probe did not complete");
    assert.equal(result.model, model.modelId, "Catalog probe returned a different model");
    return result;
  };
  const first = await call([prompt], { type: "function", name: tool.name });
  const calls = first.output.filter((i) => i.type === "function_call");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, tool.name);
  assert.deepEqual(JSON.parse(calls[0].arguments), {});
  const second = await call(
    [
      prompt,
      ...first.output,
      { type: "function_call_output", call_id: calls[0].call_id, output: "CATALOG_ROUTE_OK" },
    ],
    "none",
  );
  const text = second.output
    .flatMap((i) => i.content ?? [])
    .filter((c) => c.type === "output_text")
    .map((c) => c.text)
    .join("")
    .trim();
  assert.equal(text, "CATALOG_ROUTE_OK", "Catalog probe marker mismatch");
  return {
    modelId: model.modelId,
    provider: model.provider,
    checkedAt: new Date().toISOString(),
    text: true,
    functionCalling: true,
    usage: [first, second].map((r) => ({
      input: r.usage?.input_tokens,
      output: r.usage?.output_tokens,
    })),
  };
}
