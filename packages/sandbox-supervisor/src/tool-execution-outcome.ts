import { ToolExecutionFailure } from "@pi-cloud/protocol";

const UNAVAILABLE_TOOL_CODES = new Set([
  "cubesandbox_tool_result_unknown",
  "cubesandbox_tool_unavailable",
  "tool_sandbox_identity_mismatch",
  "tool_command_executor_closed",
  "tool_command_sealed",
  "tool_operation_outcome_unknown",
  "stale_session_lease",
  "ownership_lost",
]);

/** Only explicit missing-transport evidence can use the fault-path readiness check. */
export function permitsReadinessCheck(failure: ToolExecutionFailure): boolean {
  return (
    failure.effect === "unknown" &&
    (failure.code === "tool_reply_timeout" || failure.code === "tool_handoff_unconfirmed")
  );
}

/** Negative execution evidence is a confirmed outcome, not a missing reply. */
export function confirmsNoToolEffect(error: unknown): error is ToolExecutionFailure {
  return error instanceof ToolExecutionFailure && error.effect === "not_started";
}

/** Called only at a trusted transport boundary, never on native Tool text. */
export function toolTransportFailure(
  cause: unknown,
  code = "tool_operation_outcome_unknown",
): ToolExecutionFailure {
  if (cause instanceof ToolExecutionFailure) return cause;
  return new ToolExecutionFailure(
    {
      code,
      effect: "unknown",
      message: "Tool reply could not be confirmed; inspect effects before repeating the operation",
    },
    { cause },
  );
}

export function blocksToolSampling(failure: ToolExecutionFailure): boolean {
  return failure.effect === "unknown" || UNAVAILABLE_TOOL_CODES.has(failure.code);
}
