/** Platform transport ambiguity must stay UNKNOWN in live and restored views. */
export function toolResultIsUnknown(value: unknown): boolean {
  try {
    const serialized = JSON.stringify(value);
    return (
      typeof serialized === "string" &&
      [
        "cubesandbox_tool_result_unknown",
        "tool_operation_outcome_unknown",
        "tool_result_released",
        "tool_command_delivery_unknown",
      ].some((code) => serialized.includes(code))
    );
  } catch {
    return false;
  }
}
