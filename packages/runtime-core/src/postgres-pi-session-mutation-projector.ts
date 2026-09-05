import type { Database } from "@pi-cloud/database";
import { PostgresPiSessionStorage } from "@pi-cloud/pi-session-postgres";
import { SessionError } from "@earendil-works/pi-agent-core";
import { sql, type Kysely } from "kysely";
import type { AcceptedPiSessionMutationFact } from "./accepted-fact.ts";

export class PostgresPiSessionMutationProjector {
  readonly #database: Kysely<Database>;
  #projectedSinceCleanup = 0;

  constructor(database: Kysely<Database>) {
    this.#database = database;
  }

  async project(fact: AcceptedPiSessionMutationFact): Promise<void> {
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
        const existing = await transaction
          .selectFrom("pi_session_mutation_results")
          .select("mutation_id")
          .where("mutation_id", "=", fact.factId)
          .executeTakeFirst();
        if (existing !== undefined) return;
        const storage = new PostgresPiSessionStorage({
          database: transaction,
          tenantId: fact.scope.tenantId,
          sessionId: fact.piSession.id,
          turnId: fact.scope.turnId,
          projectedMutationId: fact.factId,
        });
        const result =
          fact.operation.kind === "projection_barrier"
            ? { kind: "projection_barrier" as const }
            : await applyOperation(storage, fact.operation);
        await this.#recordResult(transaction, fact, "completed", result ?? null);
      });
    } catch (error: unknown) {
      if (!(error instanceof SessionError)) throw error;
      await this.#recordResult(this.#database, fact, "failed", null, error);
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
        result: result as Record<string, unknown> | null,
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
    case "projection_barrier":
      return undefined;
  }
}
