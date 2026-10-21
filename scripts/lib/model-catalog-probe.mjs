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
  // The reviewed Flash request ID and its upstream response ID differ (ADR-0191).
  // Keep this bounded alias explicit; arbitrary provider/model substitution fails.
  const responseModels = new Set([
    model.modelId,
    ...(model.provider === "deepseek" && model.modelId === "deepseek-v4-flash"
      ? ["deepseek-flash"]
      : []),
  ]);
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
        // DeepSeek thinking mode accepts automatic selection, not a forced
        // function. Preserve offered tools when reading the result, as the
        // ordinary Agent does; settlement below rejects another invocation.
        tools: [tool],
        tool_choice: model.provider === "deepseek" ? "auto" : choice,
        max_output_tokens: Math.min(model.maxTokens, 512),
        ...(model.thinkingLevels.includes("low") ? { reasoning: { effort: "low" } } : {}),
      }),
      signal: AbortSignal.timeout(120000),
    });
    assert.equal(response.status, 200, `Catalog model probe returned HTTP ${response.status}`);
    const result = await response.json();
    assert.equal(result.status, "completed", "Catalog probe did not complete");
    assert(responseModels.has(result.model), "Catalog probe returned a different model");
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
    "auto",
  );
  assert.equal(
    second.output.filter((item) => item.type === "function_call").length,
    0,
    "Catalog probe repeated its Tool invocation",
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
    responseModels: [first.model, second.model],
    checkedAt: new Date().toISOString(),
    text: true,
    functionCalling: true,
    usage: [first, second].map((r) => ({
      input: r.usage?.input_tokens,
      output: r.usage?.output_tokens,
    })),
  };
}
