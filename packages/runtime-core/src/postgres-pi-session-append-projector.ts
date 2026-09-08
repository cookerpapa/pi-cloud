import type { Database } from "@pi-cloud/database";
import { projectNativeSessionAppend } from "@pi-cloud/pi-session-postgres";
import type { Kysely } from "kysely";
import type { AcceptedPiSessionAppendFact } from "./accepted-fact.ts";
import { recordFactProjection, type FactPosition } from "./accepted-fact-recovery.ts";

export class PostgresPiSessionAppendProjector {
  constructor(readonly database: Kysely<Database>) {}

  async project(
    fact: AcceptedPiSessionAppendFact,
    requireProductSession = false,
    position?: FactPosition,
  ): Promise<void> {
    await this.database.transaction().execute(async (tx) => {
      if (requireProductSession) {
        // Coordinate with seals, not a lease which may expire after Kafka ACK.
        const attempt = await tx
          .selectFrom("run_attempts")
          .select(["output_sealed_at", "output_projected_offset"])
          .where("tenant_id", "=", fact.scope.tenantId)
          .where("id", "=", fact.scope.attemptId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (!attempt || attempt.output_sealed_at !== null) return;
        const writer = await tx
          .selectFrom("run_attempts")
          .select("native_writer_seal_offset")
          .where("tenant_id", "=", fact.scope.tenantId)
          .where("id", "=", fact.scope.writerId)
          .forNoKeyUpdate()
          .executeTakeFirst();
        if (
          !writer ||
          (position &&
            writer.native_writer_seal_offset !== null &&
            position.offset >= BigInt(writer.native_writer_seal_offset))
        )
          return;
        if (
          position &&
          attempt.output_projected_offset !== null &&
          BigInt(attempt.output_projected_offset) >= position.offset
        )
          return;
      }
      await projectNativeSessionAppend(tx, {
        tenantId: fact.scope.tenantId,
        sessionId: fact.piSession.id,
        appendId: fact.factId,
        items: fact.items,
      });
      if (position) {
        await tx
          .updateTable("run_attempts")
          .set({ output_projected_offset: position.offset.toString() })
          .where("tenant_id", "=", fact.scope.tenantId)
          .where("id", "=", fact.scope.attemptId)
          .execute();
        await recordFactProjection(tx, position);
      }
    });
    // A protocol conflict stops this partition; there is no rejected receipt
    // which allows later records to silently advance past a native log hole.
  }
}
