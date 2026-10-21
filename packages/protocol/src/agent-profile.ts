import { Type, type Static } from "typebox";

/** Product selection. Ultra is a local Agent policy, never a provider effort. */
export const AgentThinkingLevelSchema = Type.Union([
  Type.Literal("off"),
  Type.Literal("minimal"),
  Type.Literal("low"),
  Type.Literal("medium"),
  Type.Literal("high"),
  Type.Literal("xhigh"),
  Type.Literal("max"),
  Type.Literal("ultra"),
]);
export type AgentThinkingLevel = Static<typeof AgentThinkingLevelSchema>;

export function resolveAgentProfile(selected: AgentThinkingLevel) {
  return {
    selected,
    thinkingLevel: selected === "ultra" ? ("max" as const) : selected,
    delegation: selected === "ultra" ? ("proactive" as const) : ("explicit_request_only" as const),
  };
}
