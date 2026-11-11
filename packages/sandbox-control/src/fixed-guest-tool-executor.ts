import {
  GuestExecutionRejected,
  SandboxRuntimeClientError,
  SandboxRuntimeTransportError,
} from "./guest-runtime-client.ts";
import {
  TOOL_REPLY_DELIVERY_MARGIN_MS,
  type AcceptedToolCommand,
  type ExecutionLogPosition,
  type ToolExecutionFailureData,
} from "@pi-cloud/protocol";
import type { GuestRuntimeClient } from "./guest-runtime-client.ts";
import type { SandboxBinding } from "./sandbox-bindings.ts";
import { executionTargetId, type SandboxExecutionTarget } from "./sandbox-execution.ts";
import type {
  SandboxToolExecutor,
  ToolExecutionCancellation,
  ToolHandoffFailure,
} from "./tool-executor.ts";
import type { ToolCompletionIssuer } from "./tool-completion-issuer.ts";

/** Provider mechanics remain behind the complete-Tool port.
 * The fixed Guest service owns admission/execution independently of this client. */
export class FixedGuestToolExecutor implements SandboxToolExecutor {
  constructor(
    readonly client: Pick<GuestRuntimeClient, "submitTool" | "cancelTool">,
    readonly completion: Pick<ToolCompletionIssuer, "issue">,
  ) {}

  async submit(
    binding: SandboxBinding,
    command: AcceptedToolCommand,
    source: ExecutionLogPosition,
  ): Promise<void> {
    const context = {
      execution: {
        bindingId: binding.bindingId,
        targetId: executionTargetId(binding.descriptor.target),
        bootId: binding.descriptor.target.bootId,
        continuityId: binding.snapshot.physicalActivationId,
        ...(binding.snapshot.continuity ? { continuity: binding.snapshot.continuity } : {}),
      },
      scope: command.scope,
      replyTopic: command.replyTopic!,
      toolCallId: command.toolCallId,
      nativeToolCallId: command.request.toolCallId,
      toolName: command.request.toolName,
      partition: source.partition,
    };
    const grant = {
      operationId: command.request.operationId,
      context,
      expiresAt:
        command.replyRecovery?.deadlineAt ??
        Date.parse(command.occurredAt) + command.request.timeoutMs + TOOL_REPLY_DELIVERY_MARGIN_MS,
    };
    const guest = await this.completion.issue(grant).catch(() => {
      throw new GuestExecutionRejected("execution_endpoint_unconfigured");
    });
    return this.client.submitTool(binding.descriptor.target, {
      source,
      operationId: command.request.operationId,
      executionScopeId: binding.bindingId,
      writerId: command.scope.writerId,
      payload: {
        toolWorkerProtocolVersion: 7,
        type: "worker.operation",
        attachment: binding.descriptor.attachment,
        request: command.request,
        delivery: guest,
      },

      timeoutMs: command.request.timeoutMs + TOOL_REPLY_DELIVERY_MARGIN_MS,
    });
  }

  cancel(target: SandboxExecutionTarget, request: ToolExecutionCancellation): Promise<void> {
    return this.client.cancelTool(target, request);
  }

  cancellationRefused(error: unknown): boolean {
    return error instanceof GuestExecutionRejected;
  }

  handoffFailure(error: unknown): ToolHandoffFailure {
    let code = "cubesandbox_tool_result_unknown";
    let effect: ToolExecutionFailureData["effect"] = "unknown";
    let quarantine = false;
    if (
      error instanceof SandboxRuntimeTransportError ||
      (error instanceof SandboxRuntimeClientError &&
        error.statusCode !== undefined &&
        (error.statusCode === 408 || error.statusCode === 429 || error.statusCode >= 500))
    )
      code = "tool_handoff_unconfirmed";
    if (error instanceof GuestExecutionRejected) {
      switch (error.code) {
        case "executor_replaced":
        case "runtime_quarantined":
          code = "cubesandbox_tool_unavailable";
          quarantine = true;
          break;
        case "node_unavailable":
        case "execution_unavailable":
        case "runtime_retention_unavailable":
        case "execution_endpoint_unconfigured":
        case "executor_capacity":
          code = "cubesandbox_tool_unavailable";
          effect = "not_started";
          break;
        case "execution_not_started":
        case "capacity":
        case "invalid_request":
        case "invalid_identity":
        case "invalid_execution_position":
          code = "tool_execution_not_started";
          effect = "not_started";
          break;
        // Stale positions and changed identities can describe an earlier effect.
      }
    }
    return {
      quarantine,
      failure: {
        code,
        effect,
        message:
          effect === "not_started"
            ? "The execution request was refused before admission; this delivery did not start a file or shell action."
            : "Execution handoff did not return a confirmed result. The operation may have executed or may still be running. It was not replayed; inspect effects before deciding to repeat it.",
      },
    };
  }
}
