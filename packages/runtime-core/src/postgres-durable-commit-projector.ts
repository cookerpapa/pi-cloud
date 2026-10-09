import { sql, type Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  DurablePostgresProjection,
  type StoredDurableBatch,
} from "@pi-cloud/pi-session-postgres/durable";
import type { AcceptedDurableCommitFact } from "./accepted-fact.ts";
import { recordFactProjection, type FactPosition } from "./accepted-fact-recovery.ts";
import { projectionTransaction, type ProjectionBudget } from "./projection-transaction.ts";

export class PostgresDurableCommitProjector {
  constructor(
    readonly database: Kysely<Database>,
    readonly budget?: ProjectionBudget,
  ) {}
  async project(fact: AcceptedDurableCommitFact, position: FactPosition): Promise<void> {
    await projectionTransaction(
      this.database,
      async (tx) => {
        // Materialize the locked Run before locking the shared lease. Keep this
        // append path's Run -> lease -> native order; a plain join can reorder locks.
        // Both locking reads recheck changed tuples after a concurrent lock wait.
        const {
          rows: [run],
        } = await sql<{
          lease_id: string | null;
          output_seal_offset: string | null;
          output_first_topic: string | null;
          output_first_partition: number | null;
          output_first_offset: string | null;
          writer_seal_offset: string | null;
        }>`with locked_run as materialized (
          select lease_id,output_seal_offset,output_first_topic,output_first_partition,output_first_offset
          from runs where tenant_id=${fact.scope.tenantId}::uuid and id=${fact.scope.runId}::uuid
          for no key update
        ) select r.*,l.writer_seal_offset from locked_run r
          join session_leases l on l.tenant_id=${fact.scope.tenantId}::uuid
            and l.lease_id=r.lease_id
          where r.lease_id=${fact.scope.writerId}::uuid
          for no key update of l`.execute(tx);
        if (
          !run ||
          run.lease_id !== fact.scope.writerId ||
          (run.output_seal_offset !== null && position.offset >= BigInt(run.output_seal_offset)) ||
          (run.writer_seal_offset !== null && position.offset > BigInt(run.writer_seal_offset))
        )
          return;
        const projection = new DurablePostgresProjection(tx, {
          tenantId: fact.scope.tenantId,
          sessionId: fact.scope.piSessionId,
        });
        await projection.applyIn(tx, fact.commit as unknown as StoredDurableBatch, fact.origins);
        if (
          run.output_first_offset !== null &&
          (run.output_first_topic !== position.topic ||
            run.output_first_partition !== position.partition)
        )
          throw new Error("Native Run publication moved between Kafka streams");
        if (run.output_first_offset === null)
          await tx
            .updateTable("runs")
            .set({
              output_first_topic: position.topic,
              output_first_partition: position.partition,
              output_first_offset: position.offset.toString(),
            })
            .where("tenant_id", "=", fact.scope.tenantId)
            .where("id", "=", fact.scope.runId)
            .where("lease_id", "=", fact.scope.writerId)
            .execute();
        await recordFactProjection(tx, position);
      },
      this.budget,
    );
  }
}
