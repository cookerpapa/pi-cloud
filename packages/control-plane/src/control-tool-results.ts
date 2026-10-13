import { assertSubagentResultBudget, type ToolResultData } from "@pi-cloud/protocol";

export function supervisorToolResult(
  kind: "contact" | "supervisor",
  value: Record<string, unknown>,
): ToolResultData {
  const text =
    kind === "contact"
      ? typeof value.replyMessage === "string"
        ? value.replyMessage
        : "Supervisor progress update persisted."
      : typeof value.output === "string"
        ? value.output
        : JSON.stringify(value);
  const result: ToolResultData = { content: [{ type: "text", text }], details: value };
  assertSubagentResultBudget(result);
  return result;
}
