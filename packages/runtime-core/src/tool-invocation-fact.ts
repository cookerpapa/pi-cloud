import {
  durableToolIntent,
  parseToolSandboxOperationRequest,
  type AcceptedToolCommand,
} from "@pi-cloud/protocol";
import type { AcceptedFact } from "./accepted-fact.ts";

/** Arguments appear once in Kafka, in the native execute checkpoint. Expand
 * the owned Cube command only at the external-effect dispatch boundary. */
export function toolCommandsForFact(fact: AcceptedFact): readonly AcceptedToolCommand[] {
  if (fact.kind === "tool_command") return [fact];
  if (fact.kind !== "durable_commit") return [];
  return fact.tools.map(({ taskId, ...command }) => {
    const intent = durableToolIntent(fact.commit, taskId);
    if ("args" in command.request || "toolCallId" in command.request)
      throw new Error("Tool dispatch duplicates native intent");
    const request = parseToolSandboxOperationRequest({
      ...command.request,
      args: intent.arguments,
      toolCallId: intent.callId,
    });
    return { ...command, kind: "tool_command", request };
  });
}
