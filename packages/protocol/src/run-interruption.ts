export const RUN_INTERRUPTION_CUSTOM_TYPE = "pi-cloud.run_interrupted";
export const INTERRUPTED_ASSISTANT_PREFIX_CUSTOM_TYPE = "pi-cloud.interrupted_assistant_prefix";

const explanations = {
  cancelled: "The previous Run was cancelled before it completed.",
  execution_interrupted:
    "The previous execution ended without normal completion; its exact cause may be unknown.",
  execution_timeout: "The previous execution reached its time limit.",
  worker_unavailable:
    "The previous Agent Worker became unavailable before the Run completed. Results of unfinished Tools may be unknown.",
  execution_unavailable:
    "The previous execution could not continue because its execution channel or authority was unavailable.",
  tool_result_unknown:
    "A Tool was submitted, but its result could not be confirmed. Its side effects may already have occurred.",
  model_response_interrupted: "The previous model response stream ended before completion.",
  context_limit: "The previous model request could not complete within its context limit.",
} as const;
export type RunInterruptionReason = keyof typeof explanations;

export function isRunInterruptionReason(value: unknown): value is RunInterruptionReason {
  return typeof value === "string" && Object.hasOwn(explanations, value);
}

export function interruptionReasonForFailureCode(code: unknown): RunInterruptionReason | undefined {
  switch (code) {
    case "pi_timeout":
    case "execution_timeout":
    case "tool_timeout":
      return "execution_timeout";
    case "cubesandbox_tool_result_unknown":
    case "tool_operation_outcome_unknown":
    case "tool_reply_timeout":
    case "tool_handoff_unconfirmed":
    case "tool_reply_protocol_error":
    case "workflow_result_unknown":
      return "tool_result_unknown";
    case "cubesandbox_tool_unavailable":
    case "tool_sandbox_identity_mismatch":
    case "workspace_runtime_lost":
    case "sandbox_unavailable":
    case "ownership_lost":
    case "stale_session_lease":
    case "session_lease_revoked":
      return "execution_unavailable";
    case "heartbeat_timeout":
    case "supervisor_disconnected":
    case "worker_lost":
      return "worker_unavailable";
    default:
      return undefined;
  }
}

export function runInterruptionMessage(
  reason: RunInterruptionReason = "execution_interrupted",
): string {
  return [
    "<turn_aborted>",
    explanations[reason],
    "Treat unfinished work as uncertain and inspect relevant state before continuing. Do not automatically repeat an unconfirmed command.",
    "</turn_aborted>",
  ].join("\n");
}
