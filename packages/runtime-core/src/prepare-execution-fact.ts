import type { CandidateFact, AcceptedFact, ExecutionPublication } from "./accepted-fact.ts";

export function prepareExecutionFact(
  scope: ExecutionPublication["scope"] & { executionLease: string },
  candidate: CandidateFact,
): AcceptedFact {
  if (candidate.kind === "tool_command") {
    const command = candidate.command;
    if (command.executionLease !== scope.executionLease) {
      throw new Error("Tool command does not belong to its ExecutionLease");
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
        attemptId: scope.attemptId,
        fencingToken: scope.fencingToken,
        leaseId: scope.leaseId,
        piSessionId: scope.piSessionId,
        writerId: scope.writerId,
      },
      request: command.request,
      occurredAt: command.occurredAt,
      ...(command.traceContext ? { traceContext: command.traceContext } : {}),
    };
  }
  if (candidate.kind === "agent_event") {
    const publication = candidate.publication;
    if (
      publication.payload.executionLease !== scope.executionLease ||
      publication.payload.event.sessionId !== scope.sessionId ||
      publication.payload.event.turnId !== scope.turnId
    ) {
      throw new Error("Agent event candidate does not belong to its ExecutionLease");
    }
    return {
      kind: "agent_event",
      factId: publication.payload.event.eventId,
      scope: {
        tenantId: scope.tenantId,
        sessionId: scope.sessionId,
        runId: scope.runId,
        turnId: scope.turnId,
        attemptId: scope.attemptId,
        fencingToken: scope.fencingToken,
        piSessionId: scope.piSessionId,
        writerId: scope.writerId,
      },
      event: publication.payload.event,
      occurredAt: publication.payload.event.occurredAt,
    };
  }
  const mutation = candidate.mutation;
  if (
    mutation.scope.executionLease !== scope.executionLease ||
    mutation.scope.tenantId !== scope.tenantId ||
    mutation.scope.sessionId !== scope.sessionId ||
    mutation.scope.piSessionId !== scope.piSessionId ||
    mutation.scope.piSessionLane !== scope.piSessionLane ||
    mutation.scope.writerId !== scope.writerId ||
    mutation.scope.runId !== scope.runId ||
    mutation.scope.turnId !== scope.turnId
  ) {
    throw new Error("Pi Session mutation candidate does not belong to its ExecutionLease");
  }
  const operationLanes = mutation.items.flatMap((item) =>
    item.kind === "entry"
      ? [item.lane]
      : item.kind === "record"
        ? [item.record.lane]
        : item.kind === "lane" && !item.create
          ? [item.lane]
          : [],
  );
  if (
    operationLanes.some((lane) => lane !== scope.piSessionLane) ||
    mutation.items.some((item) => item.kind === "fact" && scope.piSessionLane !== "main")
  ) {
    throw new Error("Pi Session mutation does not belong to its authorized lane");
  }
  if (
    mutation.events.some(
      (event) => event.sessionId !== scope.sessionId || event.turnId !== scope.turnId,
    )
  ) {
    throw new Error("Pi Session checkpoint event does not belong to its ExecutionLease");
  }
  return {
    kind: "pi_session_append",
    factId: mutation.mutationId,
    scope: {
      tenantId: scope.tenantId,
      sessionId: scope.sessionId,
      runId: scope.runId,
      turnId: scope.turnId,
      attemptId: scope.attemptId,
      fencingToken: scope.fencingToken,
      piSessionId: scope.piSessionId,
      writerId: scope.writerId,
    },
    piSession: { id: scope.piSessionId, lane: scope.piSessionLane, writerId: scope.writerId },
    items: mutation.items,
    events: mutation.events,
    occurredAt: mutation.occurredAt,
  };
}
