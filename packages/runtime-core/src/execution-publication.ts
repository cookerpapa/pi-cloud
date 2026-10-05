import { parseExecutionReference } from "@pi-cloud/protocol";
import type { ExecutionPublication } from "./accepted-fact.ts";
import type { ExecutionLogOpenRequest } from "./execution-log.ts";

/** Admission stores this scope together with the single Run's owner/state. */
export function createExecutionPublication(
  request: Omit<ExecutionLogOpenRequest, "publication"> & { tenantId: string; runId: string },
): ExecutionPublication {
  const lease = parseExecutionReference(request.executionReference);
  const permit: ExecutionPublication = {
    scope: {
      tenantId: request.tenantId,
      sessionId: request.sessionId,
      turnId: request.turnId,
      runId: request.runId,
      leaseId: lease.leaseId,
      fencingToken: lease.fencingToken,
      piSessionId: request.piSession.id,
      piConversationId: request.piSession.conversationId,
      writerId: lease.leaseId,
    },
  };
  if (lease.runId !== request.runId || lease.leaseId !== request.piSession.writerId)
    throw new Error("Execution publication does not match its Run and Session owner");
  return permit;
}
