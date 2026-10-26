import {
  durableToolIntent,
  durableControlIntent,
  durableControlRecovery,
  DurableCommitIndex,
  parseControlToolDispatch,
  parseExecutorToolDispatch,
  type AcceptedExecutorToolCommand,
  parseToolSandboxOperationRequest,
  type AcceptedToolCommand,
} from "@pi-cloud/protocol";
import type { AcceptedFact } from "./accepted-fact.ts";

/** Arguments appear once in Kafka, in the native execute checkpoint. Expand
 * the owned Cube command only at the external-effect dispatch boundary. */
export function toolCommandsForFact(
  fact: AcceptedFact,
  index?: DurableCommitIndex,
): readonly (AcceptedToolCommand | AcceptedExecutorToolCommand)[] {
  if (fact.kind !== "durable_commit") return [];
  index ??= new DurableCommitIndex(fact.commit);
  return fact.tools.flatMap(
    (tool, operationIndex): (AcceptedToolCommand | AcceptedExecutorToolCommand)[] => {
      if (tool.target === "control") return [];
      if (tool.target === "executor") {
        const reference = parseExecutorToolDispatch(tool);
        const intent = durableToolIntent(fact.commit, tool.taskId, index);
        if (index.task(tool.taskId)?.conversationId !== tool.conversationId)
          throw new Error("Executor Tool conversation changed");
        return [
          {
            ...reference,
            kind: "executor_tool",
            scope: tool.scope,
            nativeCallId: intent.callId,
            arguments: intent.arguments,
            operationIndex,
          },
        ];
      }
      const { taskId, target: _target, ...command } = tool;
      const intent = durableToolIntent(fact.commit, taskId, index);
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
      return [{ ...command, kind: "tool_command", toolCallId: `task:${taskId}`, request }];
    },
  );
}

/** Control input is expanded once by the PG-backed handler. This boundary
 * validates only the committed intent or the task-owned recovery reference. */
export function validateControlToolReferences(
  fact: AcceptedFact,
  index?: DurableCommitIndex,
): void {
  if (fact.kind !== "durable_commit") return;
  index ??= new DurableCommitIndex(fact.commit);
  for (const tool of fact.tools) {
    if (tool.target !== "control") continue;
    const reference = parseControlToolDispatch(tool);
    if (reference.recovery) {
      durableControlRecovery(fact.commit, reference, index);
    } else {
      durableControlIntent(fact.commit, reference, index);
      if (
        reference.sourceDocumentId === undefined &&
        index.task(reference.taskId)?.conversationId !== reference.conversationId
      )
        throw new Error("Control Tool conversation changed");
    }
  }
}
