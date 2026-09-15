import type { CloudToolCapabilitySnapshot } from "./tool-capabilities.ts";

/** Runtime control, not an assistant message or a guest shell command. */
export type SubagentControlRequest =
  | Readonly<{
      action: "contact";
      reason: "need_decision" | "interview_request" | "progress_update";
      message: string;
      interview?: Record<string, unknown>;
    }>
  | Readonly<{
      action: "supervisor";
      operation: "pending" | "reply" | "wait";
      requestId?: string;
      message?: string;
    }>
  | Readonly<{
      action: "start";
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

export type CandidateSubagentCommand = Readonly<{
  executionReference: string;
  requestId: string;
  toolCallId: string;
  workflowId: string;
  request: SubagentControlRequest;
  occurredAt: string;
}>;

export type SubagentControlResult = Readonly<{
  requestId: string;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
}>;

export interface SubagentCommandPublisher {
  publishSubagentCommand(command: CandidateSubagentCommand): Promise<void>;
}

/** Management messages only reach the exact serving Worker boot. */
export type SubagentHostRequest =
  | Readonly<{
      action: "input";
      executionReference: string;
      runId: string;
      requestId: string;
      message: string;
      delivery: "notify" | "steer" | "follow_up";
    }>
  | Readonly<{
      action: "prepare_lane";
      executionReference: string;
      lane: string;
      anchor: string | null;
    }>
  | Readonly<{ action: "schedule"; runId: string }>
  | Readonly<{
      action: "result";
      executionReference: string;
      response: SubagentControlResult;
    }>;

export const SUBAGENT_HOST_PATH = "/internal/v1/subagent-runtime";
export const TOOL_WORKFLOW_PATH = "/internal/v1/tool-workflow";
