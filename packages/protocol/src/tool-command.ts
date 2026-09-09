import type { ToolSandboxOperationRequest } from "./tool-sandbox.ts";

export type CandidateToolCommand = Readonly<{
  executionLease: string;
  toolCallId: string;
  request: ToolSandboxOperationRequest;
  occurredAt: string;
  traceContext?: Readonly<{ traceparent: string; tracestate?: string }>;
}>;

export type AcceptedToolCommand = Readonly<{
  kind: "tool_command";
  factId: string;
  toolCallId: string;
  scope: Readonly<{
    tenantId: string;
    sessionId: string;
    turnId: string;
    runId: string;
    attemptId: string;
    fencingToken: number;
    leaseId: string;
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
