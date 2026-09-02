import type { AgentModelHostedTool } from "@pi-cloud/protocol";

type ProviderPayload = Record<string, unknown>;

function isProviderPayload(value: unknown): value is ProviderPayload {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hostedToolDeclaration(tool: AgentModelHostedTool): ProviderPayload {
  switch (tool) {
    case "web_search":
      return { type: "web_search" };
  }
}

/**
 * Add only deployment-approved Provider-hosted Tools to a Provider-native
 * Responses payload. Pi function Tools remain untouched and continue through
 * Tool Broker; the Provider executes these declarations itself.
 */
export function mergeProviderHostedTools(
  payload: unknown,
  hostedTools: readonly AgentModelHostedTool[],
): unknown {
  if (hostedTools.length === 0 || !isProviderPayload(payload)) return payload;
  const existing = Array.isArray(payload.tools) ? payload.tools : [];
  const existingTypes = new Set(
    existing.flatMap((tool) =>
      isProviderPayload(tool) && typeof tool.type === "string" ? [tool.type] : [],
    ),
  );
  const additions = hostedTools
    .filter((tool) => !existingTypes.has(tool))
    .map(hostedToolDeclaration);
  return additions.length === 0 ? payload : { ...payload, tools: [...existing, ...additions] };
}

export function mergeProviderServiceTier(
  payload: unknown,
  serviceTier: "fast" | null | undefined,
): unknown {
  if (serviceTier !== "fast" || !isProviderPayload(payload)) return payload;
  return { ...payload, service_tier: "fast" };
}
