import type { Database } from "@pi-cloud/database";
import { PostgresPiSessionStorage, compactPiMutationResult } from "@pi-cloud/pi-session-postgres";
import { SessionError } from "@earendil-works/pi-agent-core";
import { sql, type Kysely } from "kysely";
import type { AcceptedPiSessionMutationFact } from "./accepted-fact.ts";
import { recordFactProjection, type FactPosition } from "./accepted-fact-recovery.ts";

export class PostgresPiSessionMutationProjector {
  readonly #database: Kysely<Database>;
  #projectedSinceCleanup = 0;

  constructor(database: Kysely<Database>) {
    this.#database = database;
  }

  async project(
    fact: AcceptedPiSessionMutationFact,
    requireProductSession = false,
    position?: FactPosition,
  ): Promise<void> {
    const offset = position?.offset;
    this.#projectedSinceCleanup += 1;
    if (this.#projectedSinceCleanup >= 256) {
      this.#projectedSinceCleanup = 0;
      await this.#database
        .deleteFrom("pi_session_mutation_results")
        .where("expires_at", "<", new Date())
        .execute();
    }
    try {
      await this.#database.transaction().execute(async (transaction) => {
        // Also serialize projection against the seal transaction. A rebalanced
        // old consumer must not mutate a lane after the new owner closes it.
        if (requireProductSession) {
          const attempt = await transaction
            .selectFrom("run_attempts")
            .select(["output_sealed_at", "output_projected_offset"])
            .where("tenant_id", "=", fact.scope.tenantId)
            .where("id", "=", fact.scope.attemptId)
            .forUpdate()
            .executeTakeFirst();
          if (!attempt || attempt.output_sealed_at !== null) return;
          if (
            offset !== undefined &&
            attempt.output_projected_offset !== null &&
            BigInt(attempt.output_projected_offset) >= offset
          )
            return;
        }
        const check = await sql<{ exists: boolean; projected: boolean }>`select
          (not ${requireProductSession} or exists(select 1 from sessions where tenant_id=${fact.scope.tenantId}::uuid and id=${fact.scope.sessionId}::uuid)) as exists,
          exists(select 1 from pi_session_mutation_results where mutation_id=${fact.factId}::uuid) as projected
        `.execute(transaction);
        if (!check.rows[0]?.exists || check.rows[0].projected) return;
        const storage = new PostgresPiSessionStorage({
          database: transaction,
          tenantId: fact.scope.tenantId,
          sessionId: fact.piSession.id,
          turnId: fact.scope.turnId,
          projectedMutationId: fact.factId,
        });
        const result = await applyOperation(storage, fact.operation);
        await this.#recordResult(transaction, fact, "completed", result ?? null);
        if (offset !== undefined)
          await transaction
            .updateTable("run_attempts")
            .set({ output_projected_offset: offset.toString() })
            .where("id", "=", fact.scope.attemptId)
            .execute();
        if (position) await recordFactProjection(transaction, position);
      });
    } catch (error: unknown) {
      if (!(error instanceof SessionError)) throw error;
      await this.#database.transaction().execute(async (transaction) => {
        if (position && requireProductSession) {
          const attempt = await transaction
            .selectFrom("run_attempts")
            .select(["output_sealed_at", "output_projected_offset"])
            .where("id", "=", fact.scope.attemptId)
            .forUpdate()
            .executeTakeFirst();
          if (
            !attempt ||
            attempt.output_sealed_at !== null ||
            (attempt.output_projected_offset !== null &&
              BigInt(attempt.output_projected_offset) >= position.offset)
          )
            return;
        }
        await this.#recordResult(transaction, fact, "failed", null, error);
        // Rejection is a final projection outcome too. Expiring the short receipt
        // must never let a formerly invalid mutation succeed against later state.
        if (position) {
          await transaction
            .updateTable("run_attempts")
            .set({ output_projected_offset: position.offset.toString() })
            .where("id", "=", fact.scope.attemptId)
            .execute();
          await recordFactProjection(transaction, position);
        }
      });
    }
  }

  async #recordResult(
    database: Kysely<Database>,
    fact: AcceptedPiSessionMutationFact,
    state: "completed" | "failed",
    result: unknown,
    error?: SessionError,
  ): Promise<void> {
    await database
      .insertInto("pi_session_mutation_results")
      .values({
        mutation_id: fact.factId,
        tenant_id: fact.scope.tenantId,
        session_id: fact.scope.sessionId,
        run_id: fact.scope.runId,
        attempt_id: fact.scope.attemptId,
        state,
        result: (state === "completed"
          ? compactPiMutationResult(fact.operation, result)
          : null) as Record<string, unknown> | null,
        error_code: error?.code ?? null,
        error_message: error?.message ?? null,
        expires_at: new Date(Date.now() + 60 * 60_000),
      })
      .onConflict((conflict) => conflict.column("mutation_id").doNothing())
      .returning(
        sql<string>`pg_notify('pi_cloud_session_projection', ${fact.factId})`.as("notification"),
      )
      .executeTakeFirst();
  }
}

async function applyOperation(
  storage: PostgresPiSessionStorage,
  operation: AcceptedPiSessionMutationFact["operation"],
): Promise<unknown> {
  switch (operation.kind) {
    case "create_lane":
      await storage.createLane(operation.lane, operation.at);
      return undefined;
    case "move_lane":
      await storage.moveLane(operation.lane, operation.to);
      return undefined;
    case "append_entry":
      return storage.appendEntry(operation.entry, operation.lane);
    case "append_record":
      return storage.appendRecord(operation.record);
    case "append_items":
      return storage.appendItems(operation.items);
    case "set_name":
      await storage.setName(operation.name);
      return undefined;
    case "set_label":
      await storage.setLabel(operation.id, operation.label);
      return undefined;
  }
}
