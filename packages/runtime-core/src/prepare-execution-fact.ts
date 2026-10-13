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
    const { executionReference, conversationId, occurredAt, ...request } = candidate.command;
    if (
      executionReference !== scope.executionReference ||
      conversationId !== scope.piConversationId
    )
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
