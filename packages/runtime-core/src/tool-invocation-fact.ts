import {
  durableToolIntent,
  durableControlIntent,
  parseControlToolDispatch,
  parseToolSandboxOperationRequest,
  type AcceptedToolCommand,
} from "@pi-cloud/protocol";
import type {
  AcceptedFact,
  AcceptedControlToolCommand,
  DurableCubeToolDispatch,
} from "./accepted-fact.ts";

/** Arguments appear once in Kafka, in the native execute checkpoint. Expand
 * the owned Cube command only at the external-effect dispatch boundary. */
export function toolCommandsForFact(fact: AcceptedFact): readonly AcceptedToolCommand[] {
  if (fact.kind === "tool_command") return [fact];
  if (fact.kind !== "durable_commit") return [];
  return fact.tools
    .filter((tool): tool is DurableCubeToolDispatch => tool.target !== "control")
    .map(({ taskId, ...command }) => {
      const intent = durableToolIntent(fact.commit, taskId);
      if (
        "args" in command.request ||
        "script" in command.request ||
        "toolCallId" in command.request
      )
        throw new Error("Tool dispatch duplicates native intent");
      const request = parseToolSandboxOperationRequest({
        ...command.request,
        ...(command.request.operation === "tool.execute"
          ? { args: intent.arguments }
          : { script: intent.arguments.script }),
        toolCallId: intent.callId,
      });
      return { ...command, kind: "tool_command", request };
    });
}

/** Control effects share the native checkpoint; this expansion is not a
 * separately published command or a second copy of its input parameters. */
export function controlToolsForFact(fact: AcceptedFact): readonly AcceptedControlToolCommand[] {
  if (fact.kind !== "durable_commit") return [];
  return fact.tools.flatMap((tool) => {
    if (tool.target !== "control") return [];
    const reference = parseControlToolDispatch(tool);
    const intent = durableControlIntent(fact.commit, tool);
    const task = fact.commit.writes.find(
      (write) => write.type === "task" && (write.value as { id?: unknown })?.id === tool.taskId,
    );
    if (
      reference.sourceDocumentId === undefined &&
      (task?.value as { conversationId?: unknown })?.conversationId !== reference.conversationId
    )
      throw new Error("Control Tool conversation changed");
    return [
      {
        ...tool,
        kind: "control_tool" as const,
        nativeCallId: intent.callId,
        arguments: intent.arguments,
        nativeSequence: fact.commit.seq,
      },
    ];
  });
}
