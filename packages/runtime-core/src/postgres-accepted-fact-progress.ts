import type { Database } from "@pi-cloud/database";
import type { Kysely } from "kysely";
import { sql } from "kysely";
import type { AcceptedAgentEventProgress, AcceptedFactProgressStore } from "./accepted-fact.ts";

export class PostgresAcceptedFactProgressStore implements AcceptedFactProgressStore {
  readonly #database: Kysely<Database>;

  constructor(database: Kysely<Database>) {
    this.#database = database;
  }

  async recordMany(progress: readonly AcceptedAgentEventProgress[]): Promise<ReadonlySet<string>> {
    if (progress.length < 1 || progress.length > 1_000) {
      throw new TypeError("Accepted Fact progress set is invalid");
    }
    const requested = progress.map((entry) => ({
      grantId: entry.grantId,
      executionId: entry.executionId,
      generation: entry.executionGeneration,
      connectionId: entry.channelConnectionId,
      instanceId: entry.channelInstanceId,
      sequence: entry.acknowledgedThroughSeq,
    }));
    const recorded = await sql<{ connectionId: string }>`
      with requested as (
        select * from jsonb_to_recordset(${JSON.stringify(requested)}::jsonb) as item(
          "grantId" uuid,
          "executionId" uuid,
          generation bigint,
          "connectionId" uuid,
          "instanceId" uuid,
          sequence bigint
        )
      )
      update execution_grants as progress
         set last_event_seq = greatest(progress.last_event_seq, requested.sequence)
        from requested
       where progress.grant_id = requested."grantId"
         and progress.execution_id = requested."executionId"
         and progress.generation = requested.generation
         and progress.fact_channel_connection_id = requested."connectionId"
         and progress.fact_channel_instance_id = requested."instanceId"
      returning progress.fact_channel_connection_id as "connectionId"
    `.execute(this.#database);
    return new Set(recorded.rows.map((row) => row.connectionId));
  }
}
