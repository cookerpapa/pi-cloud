import { createWorkspaceVolumeSettlement } from "@pi-cloud/workspace-runtime";
import { describe, expect, it } from "vitest";
import { projectInstructionsFromWorkspaceSeed } from "../src/remote-tool-sandbox-turn-runner.ts";

describe("trusted project instruction extraction", () => {
  it("defers persistent Volume bytes until the Tool Sandbox attaches them", () => {
    const settlement = createWorkspaceVolumeSettlement({
      volumeId: `pcw-${"a".repeat(48)}`,
      settlementRevision: "e".repeat(64),
      activationId: "10000000-0000-4000-8000-000000000001",
      tenantId: "tenant-project-instructions-test",
      workspaceId: "workspace-project-instructions-test",
      sourceSessionId: "session-project-instructions-test",
      bindingSha256: "a".repeat(64),
      fencingToken: 1,
      imageRevision: "test",
      environmentSpecSha256: "b".repeat(64),
      recipeCommands: [],
    });

    expect(projectInstructionsFromWorkspaceSeed(settlement)).toBeUndefined();
  });
});
