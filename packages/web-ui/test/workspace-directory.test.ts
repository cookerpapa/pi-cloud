import { describe, expect, it } from "vitest";
import {
  canPreviewWorkspaceFile,
  flattenDirectoryEntries,
  MAXIMUM_WORKSPACE_PREVIEW_BYTES,
} from "../src/WorkspaceInspector.tsx";

const directories = {
  "": [
    { name: "src", path: "src", kind: "directory" as const },
    {
      name: "README.md",
      path: "README.md",
      kind: "file" as const,
      sizeBytes: 40,
      executable: false,
    },
  ],
  src: [
    { name: "components", path: "src/components", kind: "directory" as const },
    {
      name: "index.ts",
      path: "src/index.ts",
      kind: "file" as const,
      sizeBytes: 80,
      executable: false,
    },
  ],
  "src/components": [
    {
      name: "Button.tsx",
      path: "src/components/Button.tsx",
      kind: "file" as const,
      sizeBytes: 120,
      executable: false,
    },
  ],
};

describe("live Workspace directory tree", () => {
  it("reveals only directories that were loaded and expanded", () => {
    expect(flattenDirectoryEntries(directories, new Set()).map((entry) => entry.path)).toEqual([
      "src",
      "README.md",
    ]);
    expect(
      flattenDirectoryEntries(directories, new Set(["src"])).map((entry) => entry.path),
    ).toEqual(["src", "src/components", "src/index.ts", "README.md"]);
    expect(
      flattenDirectoryEntries(directories, new Set(["src", "src/components"])).map(
        (entry) => entry.path,
      ),
    ).toEqual(["src", "src/components", "src/components/Button.tsx", "src/index.ts", "README.md"]);
  });

  it("keeps oversized files outside the bounded current-file read path", () => {
    const file = {
      name: "Button.tsx",
      path: "src/components/Button.tsx",
      kind: "file" as const,
      sizeBytes: MAXIMUM_WORKSPACE_PREVIEW_BYTES,
      executable: false,
    };
    expect(canPreviewWorkspaceFile(file)).toBe(true);
    expect(
      canPreviewWorkspaceFile({ ...file, sizeBytes: MAXIMUM_WORKSPACE_PREVIEW_BYTES + 1 }),
    ).toBe(false);
  });
});
