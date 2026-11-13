import { executeNativeTool } from "@pi-cloud/tool-sandbox/native-tools";
import { ExecutorToolError } from "@pi-cloud/executor-runtime";
import { executorToolBudget, type ToolResultData } from "@pi-cloud/protocol";
import { randomUUID } from "node:crypto";

/** Fixed Pi Tool bodies execute inside the persistent local namespace, never in the cloud Harness. */
export async function executeLocalTool(
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<ToolResultData> {
  const toolName = name.replace(/^local_/, "");
  if (!["read", "write", "edit", "bash"].includes(toolName))
    throw new Error("Local Tool unavailable");
  const output = await executeNativeTool(
    {
      toolBrokerProtocolVersion: 1,
      type: "tool_sandbox.operation",
      operation: "tool.execute",
      activationId: randomUUID(),
      operationId: randomUUID(),
      toolCallId: "local",
      toolName: toolName as "read" | "write" | "edit" | "bash",
      args,
      maximumOutputBytes: 50 * 1024,
      timeoutMs: executorToolBudget(name, args).operationMs,
    },
    "/workspace",
    signal,
    () => {},
  );
  const result: ToolResultData = {
    content: output.result.content,
    ...(output.result.details === undefined ? {} : { details: output.result.details }),
    ...(output.result.diagnostics === undefined ? {} : { diagnostics: output.result.diagnostics }),
  };
  if (output.isError) throw new ExecutorToolError("Local Tool failed", result);
  return result;
}
