import { CLOUD_TOOL_NAMES } from "./tool-capabilities.ts";
import { hasConversationWorkspace, infrastructureToolDefinitions } from "./control-tools.ts";
import type { ControlToolCatalogDefinition } from "./control-tool-catalog.ts";
import type { ExecutionTargetGrant, ToolEnvironmentRequirement } from "./execution-target.ts";

export type ConversationToolScope = {
  sessionKind: "conversation" | "subagent";
  toolCapabilities?: readonly string[];
  executionTargets?: readonly ExecutionTargetGrant[];
  depth: number;
  maximumDepth: number | null;
};
type OfferedDefinition = {
  availability?: "root" | "child" | "delegation";
  environment?: ToolEnvironmentRequirement;
  workflowScript?: unknown;
};
export function toolExecutionTarget(definition: OfferedDefinition, scope: ConversationToolScope) {
  const environment = definition.environment;
  return environment?.kind === "target" && scope.sessionKind === "conversation"
    ? scope.executionTargets?.find(
        (target) =>
          target.kind === environment.targetKind &&
          environment.capabilities.every((capability) => target.capabilities.includes(capability)),
      )
    : undefined;
}
/** Availability describes actual capabilities, never permission to delegate proactively. */
export function isConversationToolOffered(
  definition: OfferedDefinition,
  scope: ConversationToolScope,
): boolean {
  if (definition.availability === "root" && scope.sessionKind !== "conversation") return false;
  if (definition.availability === "child" && scope.sessionKind !== "subagent") return false;
  if (
    definition.availability === "delegation" &&
    scope.maximumDepth !== null &&
    scope.depth >= scope.maximumDepth
  )
    return false;
  if (
    (definition.environment?.kind === "workspace" || definition.workflowScript) &&
    !hasConversationWorkspace(scope)
  )
    return false;
  if (definition.workflowScript && !(scope.toolCapabilities ?? CLOUD_TOOL_NAMES).includes("bash"))
    return false;
  return (
    definition.environment?.kind !== "target" ||
    toolExecutionTarget(definition, scope) !== undefined
  );
}
export function effectiveToolCapabilities(
  scope: ConversationToolScope,
  catalog: readonly ControlToolCatalogDefinition[],
) {
  const runtimes: Array<"linux" | "android"> = hasConversationWorkspace(scope) ? ["linux"] : [];
  if (
    scope.sessionKind === "conversation" &&
    scope.executionTargets?.some((target) => target.kind === "android")
  )
    runtimes.push("android");
  return {
    runtimes,
    tools: [
      ...new Set([
        ...(hasConversationWorkspace(scope) ? (scope.toolCapabilities ?? CLOUD_TOOL_NAMES) : []),
        ...[...infrastructureToolDefinitions(), ...catalog]
          .filter((tool) => isConversationToolOffered(tool, scope))
          .map((tool) => tool.name),
      ]),
    ],
  };
}
