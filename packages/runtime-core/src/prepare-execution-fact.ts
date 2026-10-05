import type { CandidateFact, AcceptedFact, ExecutionPublication } from "./accepted-fact.ts";
import { randomUUID } from "node:crypto";
import { parseToolCancellation } from "@pi-cloud/protocol";
import { isDeepStrictEqual } from "node:util";

export function prepareExecutionFact(
  scope: ExecutionPublication["scope"] & { executionReference: string },
  candidate: CandidateFact,
): AcceptedFact {
  if (candidate.kind === "durable_commit") {
    const {
      leaseId: _lease,
      piConversationId: _lane,
      executionReference: _reference,
      ...identity
    } = scope;
    if (!isDeepStrictEqual(candidate.fact.scope, identity))
      throw new Error("Native commit belongs to another execution owner");
    return candidate.fact;
  }
  if (candidate.kind === "tool_cancel") {
    const { executionReference, occurredAt, ...request } = candidate.command;
    if (executionReference !== scope.executionReference)
      throw new Error("Tool cancellation does not belong to its ExecutionReference");
    const {
      leaseId: _lease,
      piConversationId: _lane,
      executionReference: _reference,
      ...identity
    } = scope;
    return parseToolCancellation({
      kind: "tool_cancel",
      factId: randomUUID(),
      scope: identity,
      request,
      occurredAt,
    });
  }
  if (candidate.kind === "path_probe") {
    const {
      leaseId: _lease,
      piConversationId: _lane,
      executionReference: _reference,
      ...identity
    } = scope;
    return { ...candidate, scope: identity };
  }
  if (candidate.kind === "subagent_command") {
    const command = candidate.command;
    if (command.executionReference !== scope.executionReference)
      throw new Error("Subagent command does not belong to its ExecutionReference");
    const { leaseId: _lease, piConversationId: _lane, executionReference, ...identity } = scope;
    return {
      kind: "subagent_command",
      factId: command.requestId,
      scope: identity,
      executionReference,
      toolCallId: command.toolCallId,
      workflowId: command.workflowId,
      request: command.request,
      occurredAt: command.occurredAt,
    };
  }
  if (candidate.kind === "tool_command") {
    const command = candidate.command;
    if (command.executionReference !== scope.executionReference) {
      throw new Error("Tool command does not belong to its ExecutionReference");
    }
    return {
      kind: "tool_command",
      factId: command.request.operationId,
      toolCallId: command.toolCallId,
      scope: {
        tenantId: scope.tenantId,
        sessionId: scope.sessionId,
        turnId: scope.turnId,
        runId: scope.runId,
        fencingToken: scope.fencingToken,
        leaseId: scope.leaseId,
        piSessionId: scope.piSessionId,
        writerId: scope.writerId,
      },
      request: command.request,
      ...(command.replyTopic ? { replyTopic: command.replyTopic } : {}),
      occurredAt: command.occurredAt,
      ...(command.traceContext ? { traceContext: command.traceContext } : {}),
    };
  }
  if (candidate.kind === "agent_event") {
    const publication = candidate.publication;
    if (
      publication.payload.executionReference !== scope.executionReference ||
      publication.payload.event.sessionId !== scope.sessionId ||
      publication.payload.event.turnId !== scope.turnId
    ) {
      throw new Error("Agent event candidate does not belong to its ExecutionReference");
    }
    return {
      kind: "agent_event",
      factId: publication.payload.event.eventId,
      scope: {
        tenantId: scope.tenantId,
        sessionId: scope.sessionId,
        runId: scope.runId,
        turnId: scope.turnId,
        fencingToken: scope.fencingToken,
        piSessionId: scope.piSessionId,
        writerId: scope.writerId,
      },
      event: publication.payload.event,
      ...(publication.payload.nativeSequence === undefined
        ? {}
        : { nativeSequence: publication.payload.nativeSequence }),
      occurredAt: publication.payload.event.occurredAt,
    };
  }
  throw new Error("Unknown execution Fact candidate");
}
