import type { DevelopmentEnvironmentResource, WorkspaceSummaryResource } from "@pi-cloud/protocol";

export function selectElasticWorkspaces(
  workspaces: readonly WorkspaceSummaryResource[],
  environments: readonly DevelopmentEnvironmentResource[],
): readonly WorkspaceSummaryResource[] {
  const exclusivelyOwned = new Set(
    environments
      .filter((environment) => environment.state !== "released")
      .map((environment) => environment.workspaceId),
  );
  return workspaces.filter((workspace) => !exclusivelyOwned.has(workspace.workspaceId));
}
