import type { Database } from "@pi-cloud/database";
import { projectNativeSessionAppend } from "@pi-cloud/pi-session-postgres";
import { committedItemSequence } from "@pi-cloud/protocol/native-session";
import { sql, type Kysely } from "kysely";
import type { AcceptedPiSessionAppendFact } from "./accepted-fact.ts";
import type { FactPosition } from "./accepted-fact-recovery.ts";
import {
  projectionTransaction,
  PROJECTION_BUDGET,
  type ProjectionBudget,
} from "./projection-transaction.ts";

export class PostgresPiSessionAppendProjector {
  constructor(
    readonly database: Kysely<Database>,
    readonly budget: ProjectionBudget = PROJECTION_BUDGET,
  ) {}

  async project(
    fact: AcceptedPiSessionAppendFact,
    position: FactPosition,
    displayThrough?: number,
  ): Promise<void> {
    await projectionTransaction(
      this.database,
      async (tx) => {
        // Coordinate with seals, not a lease which may expire after Kafka ACK.
        const run = await tx
          .selectFrom("runs")
          .select(["output_sealed_at", "output_projected_offset"])
          .where("tenant_id", "=", fact.scope.tenantId)
          .where("id", "=", fact.scope.runId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (!run || run.output_sealed_at !== null) return;
        const writer = await tx
          .selectFrom("session_leases")
          .select("writer_seal_offset")
          .where("tenant_id", "=", fact.scope.tenantId)
          .where("lease_id", "=", fact.scope.writerId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (
          !writer ||
          (writer.writer_seal_offset !== null &&
            position.offset >= BigInt(writer.writer_seal_offset))
        )
          return;
        if (
          run.output_projected_offset !== null &&
          BigInt(run.output_projected_offset) >= position.offset
        )
          return;
        await projectNativeSessionAppend(tx, {
          tenantId: fact.scope.tenantId,
          sessionId: fact.piSession.id,
          appendId: fact.factId,
          items: fact.items,
        });
        const progress = tx
          .updateTable("runs")
          .set({
            output_first_topic: sql<string>`coalesce(output_first_topic, ${position.topic})`,
            output_first_partition: sql<number>`coalesce(output_first_partition, ${position.partition})`,
            output_first_offset: sql<string>`coalesce(output_first_offset, ${position.offset.toString()}::bigint)`,
            output_projected_offset: position.offset.toString(),
            ...(displayThrough === undefined
              ? {}
              : {
                  output_display_seq: sql<string>`greatest(output_display_seq, ${displayThrough})`,
                  output_display_native_seq: sql<string>`greatest(output_display_native_seq, ${committedItemSequence(fact.items.at(-1)!)})`,
                }),
          })
          .where("tenant_id", "=", fact.scope.tenantId)
          .where("id", "=", fact.scope.runId)
          .returning("id");
        await tx
          .with("projected_run", () => progress)
          .insertInto("accepted_fact_projection_offsets")
          .columns(["topic", "partition", "next_offset"])
          .expression((db) =>
            db
              .selectFrom("projected_run")
              .select([
                sql<string>`${position.topic}::text`.as("topic"),
                sql<number>`${position.partition}::integer`.as("partition"),
                sql<string>`${(position.offset + 1n).toString()}::bigint`.as("next_offset"),
              ]),
          )
          .onConflict((conflict) =>
            conflict.columns(["topic", "partition"]).doUpdateSet({
              next_offset: sql<string>`greatest(accepted_fact_projection_offsets.next_offset, excluded.next_offset)`,
            }),
          )
          .execute();
      },
      this.budget,
    );
    // A protocol conflict stops this partition; there is no rejected receipt
    // which allows later records to silently advance past a native log hole.
  }
}
