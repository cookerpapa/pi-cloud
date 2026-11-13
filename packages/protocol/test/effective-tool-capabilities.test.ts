import { expect, it } from "vitest";
import {
  effectiveToolCapabilities,
  isConversationToolOffered,
} from "../src/effective-tool-capabilities.ts";
import { skillAvailability } from "../src/skills.ts";
import { androidToolDefinitions } from "../src/android-tools.ts";
import {
  localToolDefinitions,
  LOCAL_CAPABILITIES,
  executorToolBudget,
} from "../src/local-tools.ts";

it("uses only local file tools on an explicitly selected Linux target and preserves operation budgets", () => {
  const scope = {
    sessionKind: "conversation" as const,
    toolCapabilities: [],
    depth: 0,
    maximumDepth: null,
    executionTargets: [
      {
        targetId: "10000000-0000-4000-8000-000000000001",
        revision: "1",
        kind: "linux" as const,
        name: "local",
        capabilities: [...LOCAL_CAPABILITIES],
      },
    ],
  };
  const tools = effectiveToolCapabilities(scope, [
    ...localToolDefinitions(),
    ...androidToolDefinitions(),
  ]);
  expect(tools.runtimes).toEqual(["linux"]);
  expect(tools.tools).toContain("local_bash");
  expect(tools.tools).not.toContain("bash");
  expect(tools.tools).not.toContain("android_tap");
  expect(isConversationToolOffered({ environment: { kind: "workspace" } }, scope)).toBe(false);
  expect(
    effectiveToolCapabilities({ ...scope, sessionKind: "subagent" }, localToolDefinitions()).tools,
  ).not.toContain("local_bash");
  expect(executorToolBudget("local_bash", { timeout: 120 })).toEqual({
    operationMs: 120_000,
    replyMs: 240_000,
  });
  expect(executorToolBudget("android_tap", {})).toEqual({ operationMs: 30_000, replyMs: 90_000 });
});

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
