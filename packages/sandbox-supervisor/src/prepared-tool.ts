import type { ToolRegistration, ToolExecutionResult } from "@earendil-works/pi-durable";
import type { CandidateToolEffect, OriginalRemoteToolIntent } from "@pi-cloud/protocol";

/** Owned adapter boundary, reached by the Runner only after native Pi validation. */
export type PreparedToolExecution = Readonly<{
  command: CandidateToolEffect;
  result(): Promise<ToolExecutionResult>;
  completed(): boolean;
  dispose(): void;
}>;

export type PreparedAgentTool = ToolRegistration & {
  /** Recovery consumes the persisted original reply, never invokes a Tool again. */
  recoverySource?: "reply";
  prepareExecution?: (
    callId: string,
    args: unknown,
    signal?: AbortSignal,
  ) => Promise<PreparedToolExecution>;
  prepareRecovery?: (
    callId: string,
    args: unknown,
    signal?: AbortSignal,
    original?: OriginalRemoteToolIntent,
  ) => Promise<PreparedToolExecution>;
};
