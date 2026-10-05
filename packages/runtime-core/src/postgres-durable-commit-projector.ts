import { sql, type Kysely } from "kysely";
import type { Database } from "@pi-cloud/database";
import {
  DurablePostgresProjection,
  type StoredDurableBatch,
} from "@pi-cloud/pi-session-postgres/durable";
import type { AcceptedDurableCommitFact } from "./accepted-fact.ts";
import type { FactPosition } from "./accepted-fact-recovery.ts";
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
        // Lifecycle mutations take the Run before its shared lease/native Session.
        // Do not acquire this Run later while holding the physical Session lock.
        const run = await tx
          .selectFrom("runs")
          .select(["lease_id", "output_seal_offset"])
          .where("tenant_id", "=", fact.scope.tenantId)
          .where("id", "=", fact.scope.runId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (
          !run ||
          run.lease_id !== fact.scope.writerId ||
          (run.output_seal_offset !== null && position.offset >= BigInt(run.output_seal_offset))
        )
          return;
        const lease = await tx
          .selectFrom("session_leases")
          .select("writer_seal_offset")
          .where("tenant_id", "=", fact.scope.tenantId)
          .where("lease_id", "=", fact.scope.writerId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (
          !lease ||
          (lease.writer_seal_offset !== null && position.offset > BigInt(lease.writer_seal_offset))
        )
          return;
        const projection = new DurablePostgresProjection(tx, {
          tenantId: fact.scope.tenantId,
          sessionId: fact.scope.piSessionId,
        });
        await projection.applyIn(tx, fact.commit as unknown as StoredDurableBatch, fact.origins);
        await tx
          .updateTable("runs")
          .set({
            output_first_topic: sql`coalesce(output_first_topic,${position.topic})`,
            output_first_partition: sql`coalesce(output_first_partition,${position.partition})`,
            output_first_offset: sql`coalesce(output_first_offset,${position.offset.toString()}::bigint)`,
            output_projected_offset: position.offset.toString(),
          })
          .where("tenant_id", "=", fact.scope.tenantId)
          .where("id", "=", fact.scope.runId)
          .where("lease_id", "=", fact.scope.writerId)
          .execute();
        await tx
          .insertInto("accepted_fact_projection_offsets")
          .values({
            topic: position.topic,
            partition: position.partition,
            next_offset: (position.offset + 1n).toString(),
          })
          .onConflict((conflict) =>
            conflict.columns(["topic", "partition"]).doUpdateSet({
              next_offset: sql`greatest(accepted_fact_projection_offsets.next_offset,excluded.next_offset)`,
            }),
          )
          .execute();
      },
      this.budget,
    );
  }
}
