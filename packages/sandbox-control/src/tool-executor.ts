import type {
  AcceptedToolCommand,
  ExecutionLogPosition,
  ToolExecutionFailureData,
} from "@pi-cloud/protocol";
import type { SandboxBinding } from "./sandbox-bindings.ts";
import type { SandboxExecutionTarget } from "./sandbox-execution.ts";

export type ToolExecutionCancellation = Readonly<{
  source: ExecutionLogPosition;
  executionScopeId: string;
  writerId: string;
  operationId?: string;
}>;

export type ToolHandoffFailure = Readonly<{
  failure: ToolExecutionFailureData;
  quarantine: boolean;
}>;

/** The provider accepts a complete, already-admitted Tool. Submission returns
 * after bounded acceptance, not after the command finishes. Its completion
 * transport must outlive the submitting Projector. No lifecycle authority. */
export interface SandboxToolExecutor {
  submit(
    binding: SandboxBinding,
    command: AcceptedToolCommand,
    source: ExecutionLogPosition,
  ): Promise<void>;
  cancel(target: SandboxExecutionTarget, request: ToolExecutionCancellation): Promise<void>;
  handoffFailure(error: unknown): ToolHandoffFailure;
  cancellationRefused(error: unknown): boolean;
}
