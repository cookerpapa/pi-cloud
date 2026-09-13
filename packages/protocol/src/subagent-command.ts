import type { CloudToolCapabilitySnapshot } from "./tool-capabilities.ts";
import type { ToolSandboxAssignment, ToolBrokerWorkspaceForkRequest } from "./tool-sandbox.ts";

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
      workspace: "none" | "shared" | "isolated";
      anchor: string | null;
      tools?: CloudToolCapabilitySnapshot;
      parentActivation?: { activationId: string; assignment: ToolSandboxAssignment };
    }>
  | Readonly<{ action: "status" | "wait" | "cancel"; target: string }>
  | Readonly<{
      action: "send";
      target: string;
      message: string;
      delivery: "notify" | "steer" | "follow_up";
    }>;

export type CandidateSubagentCommand = Readonly<{
  executionLease: string;
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
      executionLease: string;
      runId: string;
      requestId: string;
      message: string;
      delivery: "notify" | "steer" | "follow_up";
    }>
  | Readonly<{ action: "fork_workspace"; request: ToolBrokerWorkspaceForkRequest }>
  | Readonly<{
      action: "prepare_lane";
      executionLease: string;
      lane: string;
      anchor: string | null;
    }>
  | Readonly<{ action: "schedule"; runId: string }>
  | Readonly<{
      action: "result";
      executionLease: string;
      response: SubagentControlResult;
    }>;

export const SUBAGENT_HOST_PATH = "/internal/v1/subagent-runtime";
export const TOOL_WORKFLOW_PATH = "/internal/v1/tool-workflow";
