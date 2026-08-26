import type { Database } from "@pi-cloud/database";
import { PostgresPiSessionStorage } from "@pi-cloud/pi-session-postgres";
import { SessionError, type Entry, type LaneRecord } from "@earendil-works/pi-agent-core";
import type { Kysely } from "kysely";
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
    const existing = await this.#database
      .selectFrom("pi_session_mutation_results")
      .select("mutation_id")
      .where("mutation_id", "=", fact.factId)
      .executeTakeFirst();
    if (existing !== undefined) return;
    const storage = new PostgresPiSessionStorage({
      database: this.#database,
      tenantId: fact.scope.tenantId,
      sessionId: fact.scope.sessionId,
      turnId: fact.scope.turnId,
      projectedMutationId: fact.factId,
    });
    try {
      const result =
        fact.operation.kind === "projection_barrier"
          ? { kind: "projection_barrier" as const }
          : await applyOperation(storage, fact.operation);
      await this.#recordResult(fact, "completed", result ?? null);
    } catch (error: unknown) {
      if (!(error instanceof SessionError)) throw error;
      await this.#recordResult(fact, "failed", null, error);
    }
  }

  async #recordResult(
    fact: AcceptedPiSessionMutationFact,
    state: "completed" | "failed",
    result: Record<string, unknown> | Entry | LaneRecord | null,
    error?: SessionError,
  ): Promise<void> {
    await this.#database
      .insertInto("pi_session_mutation_results")
      .values({
        mutation_id: fact.factId,
        tenant_id: fact.scope.tenantId,
        session_id: fact.scope.sessionId,
        run_id: fact.scope.runId,
        attempt_id: fact.scope.executionId,
        state,
        result: result as Record<string, unknown> | null,
        error_code: error?.code ?? null,
        error_message: error?.message ?? null,
        expires_at: new Date(Date.now() + 60 * 60_000),
      })
      .onConflict((conflict) => conflict.column("mutation_id").doNothing())
      .executeTakeFirst();
  }
}

async function applyOperation(
  storage: PostgresPiSessionStorage,
  operation: AcceptedPiSessionMutationFact["operation"],
): Promise<Entry | LaneRecord | undefined> {
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
