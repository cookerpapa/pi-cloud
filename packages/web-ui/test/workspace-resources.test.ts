import { describe, expect, it } from "vitest";
import { selectElasticWorkspaces } from "../src/workspace-resources.ts";

describe("Workspace resource classification", () => {
  it("returns a released exclusive Workspace to the elastic pool", () => {
    const workspace = {
      workspaceId: "10000000-0000-4000-8000-000000000001",
      projectId: "10000000-0000-4000-8000-000000000002",
      name: "released-machine-files",
      sessionCount: 1,
      createdAt: "2026-08-24T00:00:00.000Z",
      lastActiveAt: "2026-08-24T00:00:00.000Z",
    };
    const environment = {
      environmentId: "10000000-0000-4000-8000-000000000003",
      projectId: workspace.projectId,
      workspaceId: workspace.workspaceId,
      workspaceName: workspace.name,
      generation: 1,
      profileKey: "standard" as const,
      cpuCount: 2,
      memoryMiB: 4_096,
      systemDiskGiB: 16,
      createdAt: "2026-08-24T00:00:00.000Z",
      updatedAt: "2026-08-24T00:00:00.000Z",
    };

    expect(selectElasticWorkspaces([workspace], [{ ...environment, state: "running" }])).toEqual(
      [],
    );
    expect(
      selectElasticWorkspaces(
        [workspace],
        [{ ...environment, state: "released", releasedAt: "2026-08-24T00:10:00.000Z" }],
      ),
    ).toEqual([workspace]);
  });
});
