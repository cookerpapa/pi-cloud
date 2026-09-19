import type { Database } from "@pi-cloud/database";
import type { Transaction, Kysely } from "kysely";
import { SessionLeaseCoordinator } from "../../runtime-core/src/session-lease-coordinator.ts";
import {
  RunExecutor,
  type RunExecutorOptions,
  type TurnExecutionBackend,
} from "../../runtime-core/src/run-executor.ts";
import type {
  TurnExecutionRequest,
  ExecutionAdmissionFacts,
} from "../../runtime-core/src/run-executor.ts";
import { createExecutionPublication } from "../../runtime-core/src/execution-publication.ts";
import { parseExecutionReference } from "@pi-cloud/protocol";

/** Test backends obey the same committed admission contract as the real Runner. */
export async function admitTestExecution(
  coordinator: SessionLeaseCoordinator,
  tx: Transaction<Database>,
  request: TurnExecutionRequest,
  facts: ExecutionAdmissionFacts,
) {
  const reference = await coordinator.acquireInTransaction(tx, request, facts);
  const publication = createExecutionPublication({
    ...reference,
    tenantId: request.tenantId,
    runId: request.runId,
    sessionId: request.sessionId,
    turnId: request.turnId,
    piSession: {
      id: request.piSessionId,
      lane: request.piSessionLane,
      writerId: parseExecutionReference(reference.executionReference).leaseId,
    },
    nextEventSeq: Number(request.nextEventSeq),
  });
  return { ...reference, publication };
}

/** Fake Agent loops still use real queue, ownership, lifecycle and closure SQL. */
export async function createTestWorker(database: Kysely<Database>, capacity = 16) {
  const workerId = crypto.randomUUID();
  await database
    .insertInto("sandboxes")
    .values({
      id: workerId,
      supervisor_id: workerId,
      boot_id: crypto.randomUUID(),
      state: "ready",
      max_concurrent_sessions: capacity,
    })
    .execute();
  const coordinator = new SessionLeaseCoordinator({ database, sandboxId: workerId });
  return {
    workerId,
    coordinator,
    executor(
      backend: Pick<TurnExecutionBackend, "execute"> & Partial<Pick<TurnExecutionBackend, "admit">>,
      options: Omit<
        RunExecutorOptions,
        "database" | "backend" | "workerId" | "executionAuthority"
      > & { database?: Kysely<Database> } = {},
    ) {
      return new RunExecutor({
        ...options,
        database: options.database ?? database,
        workerId,
        executionAuthority: coordinator,
        backend: {
          admit:
            backend.admit ??
            ((tx, r, _mark, facts) => admitTestExecution(coordinator, tx, r, facts)),
          async execute(r, l, a) {
            const result = await backend.execute(r, l, a);
            await database
              .updateTable("runs")
              .set({ native_output_drained: true })
              .where("id", "=", r.runId)
              .execute();
            return result;
          },
        },
      });
    },
  };
}
