import { isDeepStrictEqual } from "node:util";
import {
  parseToolSandboxOperationRequest,
  type AcceptedToolCommand,
  type CandidateToolCommand,
} from "@pi-cloud/protocol";
import type {
  AcceptedFact,
  AcceptedPiSessionAppendFact,
  ToolInvocationDispatch,
} from "./accepted-fact.ts";

export function isNativeAppendFact(fact: AcceptedFact): fact is AcceptedPiSessionAppendFact {
  return fact.kind === "pi_session_append" || fact.kind === "tool_invocation";
}

function invocationIntent(fact: AcceptedPiSessionAppendFact) {
  const item = fact.items[0];
  if (
    fact.items.length !== 1 ||
    item?.kind !== "record" ||
    item.record.type !== "tool_started" ||
    item.record.lane !== fact.piSession.lane ||
    item.record.replay !== "never"
  )
    throw new Error("Tool invocation requires exactly one admitted native intent");
  return item.record;
}

export function prepareToolInvocationDispatch(
  fact: AcceptedPiSessionAppendFact,
  command: CandidateToolCommand,
): ToolInvocationDispatch {
  const intent = invocationIntent(fact);
  const request = command.request;
  if (
    request.operation !== "tool.execute" ||
    !command.replyTopic ||
    command.toolCallId !== intent.resultEntryId ||
    request.toolCallId !== intent.toolCallId ||
    request.toolName !== intent.toolName ||
    !isDeepStrictEqual(request.args, intent.effectiveArgs)
  )
    throw new Error("Tool command does not match its native intent");
  const { args: _args, toolCallId: _id, toolName: _name, ...dispatch } = request;
  return {
    request: dispatch,
    replyTopic: command.replyTopic,
    ...(command.traceContext ? { traceContext: command.traceContext } : {}),
  };
}

/** Expand only at the effect boundary; Broker receives its existing owned schema. */
export function toolCommandForFact(fact: AcceptedFact): AcceptedToolCommand | undefined {
  if (fact.kind === "tool_command") return fact;
  if (fact.kind !== "tool_invocation") return undefined;
  const intent = invocationIntent(fact);
  const { command } = fact;
  if (
    !command.replyTopic ||
    "args" in command.request ||
    "toolCallId" in command.request ||
    "toolName" in command.request
  )
    throw new Error("Tool dispatch must reuse its native intent arguments and identity");
  const request = parseToolSandboxOperationRequest({
    ...command.request,
    toolCallId: intent.toolCallId,
    toolName: intent.toolName,
    args: intent.effectiveArgs,
  });
  if (request.operation !== "tool.execute") throw new Error("Invalid Tool invocation operation");
  return {
    kind: "tool_command",
    factId: request.operationId,
    scope: { ...fact.scope, leaseId: fact.scope.writerId },
    toolCallId: intent.resultEntryId,
    request,
    replyTopic: command.replyTopic,
    occurredAt: fact.occurredAt,
    ...(command.traceContext ? { traceContext: command.traceContext } : {}),
  };
}
