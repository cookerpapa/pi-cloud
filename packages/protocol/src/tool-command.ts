import type { ToolSandboxOperationRequest } from "./tool-sandbox.ts";
import type { CandidateControlToolCommand } from "./control-tool-command.ts";

export type CandidateToolEffect = CandidateToolCommand | CandidateControlToolCommand;
export function isControlToolCommand(
  command: CandidateToolEffect,
): command is CandidateControlToolCommand {
  return "target" in command && command.target === "control";
}

export type CandidateToolCommand = Readonly<{
  executionReference: string;
  /** Cloud invocation identity (native result Entry ID); request retains the Pi call ID. */
  toolCallId: string;
  /** Logical Tool may use the workflow executor's Bash transport. */
  nativeToolName?: string;
  replyTopic?: string;
  request: ToolSandboxOperationRequest;
  occurredAt: string;
  traceContext?: Readonly<{ traceparent: string; tracestate?: string }>;
}>;

export type AcceptedToolCommand = Readonly<{
  kind: "tool_command";
  toolCallId: string;
  replyTopic?: string;
  scope: Readonly<{
    tenantId: string;
    sessionId: string;
    turnId: string;
    runId: string;
    fencingToken: number;
    piSessionId: string;
    writerId: string;
  }>;
  request: ToolSandboxOperationRequest;
  occurredAt: string;
  traceContext?: CandidateToolCommand["traceContext"];
}>;

export interface ToolCommandPublisher {
  publishToolCommand(
    command: CandidateToolCommand,
  ): Promise<Readonly<{ operationId: string; accepted: true }>>;
}
