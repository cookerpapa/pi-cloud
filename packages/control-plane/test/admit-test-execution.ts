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
import { ExecutionStreamProjector } from "../../runtime-core/src/execution-stream-projection.ts";
import type { AcceptedWorkFinishedFact } from "../../runtime-core/src/accepted-fact.ts";

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
      conversationId: request.piConversationId,
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
    .insertInto("workers")
    .values({
      id: workerId,
      supervisor_id: workerId,
      boot_id: crypto.randomUUID(),
      state: "ready",
      max_concurrent_sessions: capacity,
    })
    .execute();
  const coordinator = new SessionLeaseCoordinator({ database, workerId: workerId });
  return {
    workerId,
    coordinator,
    executor(
      backend: Pick<TurnExecutionBackend, "execute"> &
        Partial<Pick<TurnExecutionBackend, "admit">> & {
          finish?(fact: AcceptedWorkFinishedFact): Promise<void>;
          unavailablePublication?: true;
        },
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
            let installed = false;
            const install = (base: number) => {
              if (installed || backend.unavailablePublication) return;
              installed = true;
              l.publicationReady(testWorkPublication(database, r, a, base, backend.finish));
            };
            try {
              const result = await backend.execute(
                r,
                {
                  ...l,
                  publicationReady: (publication) => {
                    installed = true;
                    l.publicationReady(publication);
                  },
                },
                a,
              );
              install(result.lastEventSeq ?? Number(r.nextEventSeq) - 1);
              return result;
            } catch (error) {
              install(Number(r.nextEventSeq) - 1);
              throw error;
            }
          },
        },
      });
    },
  };
}

/** Fake transport obeys the same writer cutoff and projection-owned completion. */
export function testWorkPublication(
  database: Kysely<Database>,
  request: TurnExecutionRequest,
  admission: import("../../runtime-core/src/run-executor.ts").TurnExecutionAdmission,
  baseSequence = Number(request.nextEventSeq) - 1,
  publish?: (fact: AcceptedWorkFinishedFact) => Promise<void>,
): Parameters<
  import("../../runtime-core/src/run-executor.ts").TurnExecutionLifecycle["publicationReady"]
>[0] {
  const {
    leaseId: _lease,
    piConversationId: _conversation,
    ...scope
  } = admission.publication.scope;
  return {
    close: async () => {},
    finish: async (terminal) => {
      const fact: AcceptedWorkFinishedFact = {
        kind: "work_finished",
        scope,
        factId: crypto.randomUUID(),
        agentId: "root",
        baseSequence,
        nativeSequence: 0,
        terminal,
        retireWriter: true,
        occurredAt: new Date().toISOString(),
      };
      if (publish) {
        await publish(fact);
        return;
      }
      const row = await database
        .selectFrom("runs")
        .innerJoin("session_leases as writer", "writer.lease_id", "runs.lease_id")
        .select([
          "output_first_topic",
          "output_first_partition",
          "output_first_offset",
          "writer.writer_sealed_at",
        ])
        .where("runs.id", "=", request.runId)
        .executeTakeFirstOrThrow();
      if (row.writer_sealed_at !== null) throw new Error("Fixture writer fenced by seal");
      await new ExecutionStreamProjector(database).project({
        fact,
        topic: row.output_first_topic ?? "test-root-completion",
        partition: row.output_first_partition ?? 0,
        offset: BigInt(row.output_first_offset ?? "0") + 1000000n,
      });
    },
  };
}
