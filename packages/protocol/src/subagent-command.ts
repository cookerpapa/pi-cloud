import type { CloudToolCapabilitySnapshot } from "./tool-capabilities.ts";

/** Subagent control originates at a committed native Tool task, not a provider call ID. */
export function parseSubagentTaskId(value: string): number {
  if (typeof value !== "string" || !/^task:[1-9][0-9]*$/.test(value))
    throw new TypeError("Subagent owner must be a native Tool task");
  const id = Number(value.slice(5));
  if (!Number.isSafeInteger(id)) throw new TypeError("Native Tool task ID is invalid");
  return id;
}

/** Runtime control, not an assistant message or a guest shell command. */
export type SubagentControlRequest =
  | Readonly<{
      action: "run";
      key: string;
      task: string;
      context: "fresh" | "branch";
      sandbox: "none" | "shared" | "ephemeral";
      cwd?: string;
      anchor: string | null;
      tools?: CloudToolCapabilitySnapshot;
    }>
  | Readonly<{ action: "status" | "wait" | "cancel"; target: string }>
  | Readonly<{
      action: "send";
      target: string;
      message: string;
      delivery: "notify" | "steer" | "follow_up";
    }>;

/** Management messages only reach the exact serving Worker boot. */
export type SubagentHostRequest =
  | Readonly<{
      action: "input";
      executionReference: string;
      runId: string;
      conversationId: number;
      requestId: string;
      message: string;
      delivery: "notify" | "steer" | "follow_up";
    }>
  | Readonly<
      { action: "start_conversation" } & import("./conversation-work.ts").ConversationStartRequest
    >
  | Readonly<{ action: "stop_conversation"; executionReference: string; requestId: string }>;

export const SUBAGENT_HOST_PATH = "/internal/v1/subagent-runtime";
export const TOOL_WORKFLOW_PATH = "/internal/v1/tool-workflow";
