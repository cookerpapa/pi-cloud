import type { Database } from "@pi-cloud/database";
import type { Transaction } from "kysely";
import type { SessionLeaseCoordinator } from "../../runtime-core/src/session-lease-coordinator.ts";
import type {
  TurnExecutionRequest,
  ExecutionAdmissionFacts,
} from "../../runtime-core/src/run-executor.ts";
import { registerExecutionPublication } from "../../runtime-core/src/execution-publication.ts";

/** Test backends obey the same committed admission contract as the real Runner. */
export async function admitTestExecution(
  coordinator: SessionLeaseCoordinator,
  tx: Transaction<Database>,
  request: TurnExecutionRequest,
  facts: ExecutionAdmissionFacts,
) {
  const reference = await coordinator.acquireInTransaction(tx, request, facts);
  const publication = await registerExecutionPublication(tx, {
    ...reference,
    tenantId: request.tenantId,
    runId: request.runId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    piSession: {
      id: request.piSessionId,
      lane: request.piSessionLane,
      writerId: request.piSessionWriterId,
    },
    nextEventSeq: Number(request.nextEventSeq),
  });
  return { ...reference, publication };
}
