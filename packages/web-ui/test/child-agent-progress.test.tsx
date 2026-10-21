import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import type { DelegatedSessionSummaryResource, RunObservation } from "@pi-cloud/protocol";
import { ChildAgentProgressContext, childProgressLabel } from "../src/ChildAgentProgress.tsx";
import { ToolActivity } from "../src/ToolActivity.tsx";
import { RunObservationStore } from "../src/run-observation-store.ts";
import type { Translate } from "../src/i18n.tsx";

const child: DelegatedSessionSummaryResource = {
  executionId: "child-work",
  sessionId: "child",
  turnId: "child-turn",
  parentSessionId: "parent",
  parentTurnId: "parent-turn",
  parentToolCallId: "task:10",
  rootSessionId: "parent",
  depth: 1,
  title: "实现骑行场景",
  contextMode: "fresh",
  sandboxMode: "shared",
  state: "running",
  workspaceName: "project",
  createdAt: new Date(0).toISOString(),
};
const update: Extract<RunObservation, { type: "run.child_activity" }> = {
  type: "run.child_activity",
  sessionId: "parent",
  turnId: "parent-turn",
  runId: "run",
  generation: 2,
  revision: 1,
  observedAt: 100_000,
  lastActivityAt: 100_000,
  childSessionId: "child",
  childTurnId: "child-turn",
  parentToolCallId: "task:10",
  phase: "executing_tool",
  state: "running",
};
const t: Translate = (key) => key;

it("shows current child phases, turns stale data into unknown freshness and gives terminal state precedence", () => {
  expect(childProgressLabel(child, update, 100_001, t)).toBe("run.phase.executing_tool");
  expect(childProgressLabel(child, update, 200_000, t)).toBe("child.updating");
  expect(childProgressLabel({ ...child, state: "completed" }, update, 100_001, t)).toBe(
    "turn.completed",
  );
  expect(childProgressLabel(child, { ...update, childSessionId: "other" }, 100_001, t)).toBe(
    "child.updating",
  );
  expect(childProgressLabel(child, { ...update, state: "cancelled" }, 100_001, t)).toBe(
    "child.cancelled",
  );
});

it("retains simultaneous children and replaces all old phases after writer handoff", () => {
  const store = new RunObservationStore();
  const stop = store.subscribe("parent-turn", () => {});
  store.receive(update);
  store.receive({ ...update, childSessionId: "sibling", childTurnId: "sibling-turn" });
  expect(store.get("parent-turn")?.children?.size).toBe(2);
  store.receive({ ...update, generation: 3 });
  store.receive({ ...update, generation: 2, revision: 20, childSessionId: "sibling" });
  expect(store.get("parent-turn")?.children?.size).toBe(1);
  stop();
});

it("renders a child summary and navigation while leaving invocation details closed", () => {
  const markup = renderToStaticMarkup(
    <ChildAgentProgressContext.Provider
      value={{ turnId: "parent-turn", children: [child], onNavigate() {} }}
    >
      <ToolActivity
        item={{
          kind: "tool",
          key: "call",
          toolCallId: "task:10",
          toolName: "subagent",
          input: { task: "Long task instructions" },
          status: "running",
          firstSequence: 1,
          lastSequence: 1,
          startedAt: new Date(0).toISOString(),
        }}
      />
    </ChildAgentProgressContext.Provider>,
  );
  expect(markup).toContain("实现骑行场景");
  expect(markup).toContain("查看");
  expect(markup).toContain("<details>");
  expect(markup).not.toMatch(/<details[^>]*\bopen\b/);
});
