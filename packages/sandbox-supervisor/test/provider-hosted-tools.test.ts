import { describe, expect, it } from "vitest";
import {
  mergeProviderHostedTools,
  mergeProviderServiceTier,
} from "../src/provider-hosted-tools.ts";

describe("Provider-hosted Tool payloads", () => {
  it("adds Web Search beside Pi function Tools without changing their schemas", () => {
    const functionTool = {
      type: "function",
      name: "read",
      description: "Read a file",
      parameters: { type: "object" },
    };
    const payload = { model: "gpt-6-sol", tools: [functionTool] };

    expect(mergeProviderHostedTools(payload, ["web_search"])).toEqual({
      model: "gpt-6-sol",
      tools: [functionTool, { type: "web_search" }],
    });
    expect(payload).toEqual({ model: "gpt-6-sol", tools: [functionTool] });
  });

  it("is idempotent and leaves a payload unchanged when no hosted Tool is enabled", () => {
    const withSearch = { tools: [{ type: "web_search" }] };
    expect(mergeProviderHostedTools(withSearch, ["web_search"])).toBe(withSearch);

    const functionOnly = { tools: [{ type: "function", name: "bash" }] };
    expect(mergeProviderHostedTools(functionOnly, [])).toBe(functionOnly);
  });

  it("adds Fast as request metadata without changing Standard payloads", () => {
    const payload = { model: "gpt-6-sol", stream: true };
    expect(mergeProviderServiceTier(payload, "fast")).toEqual({
      ...payload,
      service_tier: "fast",
    });
    expect(mergeProviderServiceTier(payload, null)).toBe(payload);
  });
});
