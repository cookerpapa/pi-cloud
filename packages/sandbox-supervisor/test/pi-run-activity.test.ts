import { expect, it } from "vitest";
import { PiRunActivity } from "../src/pi-run-activity.ts";
import type { CloudAgentRuntimeEvent } from "../src/cloud-agent-runtime.ts";
import type { RunActivityUpdate } from "@pi-cloud/protocol";

it("reports observed phases and activity without exposing private deltas or arguments", () => {
  let now = 100;
  const updates: RunActivityUpdate[] = [];
  const activity = new PiRunActivity(
    (value) => updates.push(value),
    () => ++now,
  );
  const event = (value: unknown) => activity.event(value as CloudAgentRuntimeEvent);
  event({ type: "sampling_start" });
  event({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "PRIVATE" },
  });
  event({
    type: "message_update",
    assistantMessageEvent: { type: "toolcall_delta", partial: { secret: "PRIVATE" } },
  });
  event({
    type: "tool_execution_start",
    toolCallId: "child",
    toolName: "subagent",
    args: { action: "run", task: "PRIVATE" },
  });
  event({
    type: "tool_execution_start",
    toolCallId: "read",
    toolName: "read",
    args: { path: "PRIVATE" },
  });
  event({ type: "tool_execution_end", toolCallId: "read" });
  event({ type: "tool_execution_end", toolCallId: "child" });
  event({ type: "auto_retry_start" });
  event({ type: "compaction_start" });
  event({ type: "compaction_end" });
  expect(updates.map((u) => u.phase)).toEqual([
    "waiting_model",
    "receiving_model",
    "preparing_tool",
    "waiting_child",
    "executing_tool",
    "waiting_child",
    "preparing",
    "retrying",
    "compacting",
    "preparing",
  ]);
  expect(JSON.stringify(updates)).not.toContain("PRIVATE");
  expect(updates.at(-1)?.lastActivityAt).toBe(110);
  activity.phase("cancelling");
  event({ type: "agent_end" });
  expect(updates.at(-1)?.phase).toBe("cancelling");
});

it("never lets a failed observation interrupt the native Agent", () => {
  const activity = new PiRunActivity(() => {
    throw new Error("observer failed");
  });
  expect(() => activity.phase("preparing")).not.toThrow();
});
