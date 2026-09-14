import { createWorkspaceSeed } from "@pi-cloud/workspace-runtime";
import { describe, expect, it } from "vitest";
import { projectInstructionsFromWorkspaceSeed } from "../src/remote-tool-sandbox-turn-runner.ts";

describe("trusted project instruction extraction", () => {
  it("only reads supplied initialization bytes, never an archived Workspace reference", () => {
    expect(projectInstructionsFromWorkspaceSeed(undefined)).toBeUndefined();
    expect(projectInstructionsFromWorkspaceSeed(createWorkspaceSeed([]))).toBeUndefined();
    expect(
      projectInstructionsFromWorkspaceSeed(
        createWorkspaceSeed([
          {
            path: "AGENTS.md",
            content: Buffer.from("Run tests before reporting."),
            executable: false,
          },
        ]),
      ),
    ).toBe("Run tests before reporting.");
  });
});
