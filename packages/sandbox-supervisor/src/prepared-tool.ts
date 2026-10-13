import type { ToolRegistration, ToolExecutionResult } from "@earendil-works/pi-durable";
import type { CandidateToolEffect } from "@pi-cloud/protocol";

/** Owned adapter boundary, reached by the Runner only after native Pi validation. */
export type PreparedToolExecution = Readonly<{
  command: CandidateToolEffect;
  result(): Promise<ToolExecutionResult>;
  completed(): boolean;
  dispose(): void;
}>;

export type PreparedAgentTool = ToolRegistration & {
  prepareExecution?: (
    callId: string,
    args: unknown,
    signal?: AbortSignal,
  ) => Promise<PreparedToolExecution>;
};
