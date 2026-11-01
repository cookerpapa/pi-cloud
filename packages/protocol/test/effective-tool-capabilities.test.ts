import { expect, it } from "vitest";
import {
  effectiveToolCapabilities,
  isConversationToolOffered,
} from "../src/effective-tool-capabilities.ts";
import { skillAvailability } from "../src/skills.ts";
import { androidToolDefinitions } from "../src/android-tools.ts";

it("does not advertise shell workflows to a read-only child", () => {
  const scope = {
    sessionKind: "subagent" as const,
    toolCapabilities: ["read"],
    depth: 1,
    maximumDepth: null,
  };
  expect(effectiveToolCapabilities(scope, []).tools).toContain("subagent");
  expect(effectiveToolCapabilities(scope, []).tools).not.toContain("workflow");
  expect(isConversationToolOffered({ workflowScript: () => "return 1" }, scope)).toBe(false);
  const none = effectiveToolCapabilities({ ...scope, toolCapabilities: [] }, []);
  expect(none.runtimes).toEqual([]);
  expect(none.tools).not.toContain("read");
  expect(skillAvailability({ runtime: "none", tools: [], software: [] }, none).state).toBe(
    "available",
  );
});

it("offers device capabilities only to their accepted root and supports both runtime requirements", () => {
  const scope = {
    sessionKind: "conversation" as const,
    toolCapabilities: ["bash"],
    depth: 0,
    maximumDepth: null,
    executionTargets: [
      {
        targetId: "10000000-0000-4000-8000-000000000001",
        revision: "1",
        kind: "android" as const,
        name: "fixture",
        capabilities: ["screen.capture"],
      },
    ],
  };
  const catalog = androidToolDefinitions();
  const root = effectiveToolCapabilities(scope, catalog);
  expect(root.runtimes).toEqual(["linux", "android"]);
  expect(skillAvailability({ runtime: "android", tools: [], software: [] }, root).state).toBe(
    "available",
  );
  expect(
    effectiveToolCapabilities({ ...scope, sessionKind: "subagent", depth: 1 }, catalog).runtimes,
  ).toEqual(["linux"]);
  expect(
    isConversationToolOffered(
      { environment: { kind: "target", targetKind: "android", capabilities: ["screen.capture"] } },
      scope,
    ),
  ).toBe(true);
  expect(
    isConversationToolOffered(
      { environment: { kind: "target", targetKind: "android", capabilities: ["screen.tap"] } },
      scope,
    ),
  ).toBe(false);
});
